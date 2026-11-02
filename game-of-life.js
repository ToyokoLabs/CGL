/**
 * game-of-life.js
 *
 * A small, dependency-free Conway's Game of Life renderer for web pages.
 * Renders to a canvas, supports plaintext (.cells) and RLE pattern files,
 * and exposes a tiny imperative API.
 *
 * Quick start:
 *
 *   import { GameOfLife } from './game-of-life.js';
 *
 *   const life = new GameOfLife('#life', { cols: 50, rows: 50, cellSize: 10 });
 *   await life.loadPatternFromURL('patterns/glider.txt');
 *   life.start();
 *
 * Pattern object shape: { width, height, data: Uint8Array } where data is
 * row-major and a non-zero value means "alive".
 *
 * Copyright (C) 2026 Sebastian Bassi
 *
 * This file is part of CGL.
 *
 * CGL is free software: you can redistribute it and/or modify it under the
 * terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any
 * later version.
 *
 * CGL is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
 * details.
 *
 * You should have received a copy of the GNU General Public License along
 * with CGL. If not, see <https://www.gnu.org/licenses/>.
 */

const ALIVE_CHARS = new Set(['O', 'o', '*', '1']);

const DEFAULTS = {
  cols: 50,
  rows: 50,
  cellSize: 10,
  speed: 120, // milliseconds per generation
  wrap: false, // true = toroidal edges
  interactive: true, // click/drag to draw
  responsive: true, // canvas scales down to fit its container
  background: '#0b1220',
  cellColor: '#4ade80',
  gridColor: 'rgba(148, 163, 184, 0.14)',
  onUpdate: null, // called with { generation, population, running, cols, rows }
};

const MIN_SPEED = 16; // ~60 generations per second
const MAX_SPEED = 5000;

export class GameOfLife {
  /**
   * @param {string | Element} target Element or selector to mount the canvas into.
   * @param {Partial<typeof DEFAULTS>} [options]
   */
  constructor(target, options = {}) {
    const host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) throw new Error(`GameOfLife: no container found for "${target}".`);

    this.options = { ...DEFAULTS, ...options };
    this.cols = Math.max(1, Math.floor(this.options.cols));
    this.rows = Math.max(1, Math.floor(this.options.rows));
    this.cellSize = Math.max(2, Math.floor(this.options.cellSize));
    this.speed = clamp(this.options.speed, MIN_SPEED, MAX_SPEED);
    this.generation = 0;

    this._host = host;
    this._running = false;
    this._raf = null;
    this._lastTick = 0;
    this._accumulator = 0;
    this._paint = null; // cell state being painted while dragging
    this._handlers = null;

    this.grid = new Uint8Array(this.cols * this.rows);
    this._next = new Uint8Array(this.cols * this.rows);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'life-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute(
      'aria-label',
      `Conway's Game of Life grid, ${this.cols} by ${this.rows} cells${
        this.options.interactive ? ', click or drag to change cells' : ''
      }`,
    );
    this.ctx = this.canvas.getContext('2d');

    this._sizeCanvas();
    host.appendChild(this.canvas);

    if (this.options.interactive) this._bindPointerEvents();

    this._tick = this._tick.bind(this);
    this._draw();
  }

  /* ------------------------------------------------------------------ *
   * Playback
   * ------------------------------------------------------------------ */

  /** Start advancing generations. */
  start() {
    if (this._running) return;
    this._running = true;
    this._lastTick = 0;
    this._accumulator = 0;
    this._raf = requestAnimationFrame(this._tick);
    this._notify();
  }

  /** Stop advancing generations (state is kept). */
  pause() {
    if (!this._running) return;
    this._running = false;
    if (this._raf !== null) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._notify();
  }

  /** Start if paused, pause if running. */
  toggle() {
    if (this._running) this.pause();
    else this.start();
  }

  get running() {
    return this._running;
  }

  /** Advance exactly one generation. */
  step() {
    this._advance();
    this._draw();
    this._notify();
  }

  /** Milliseconds between generations (clamped to 16..5000). */
  setSpeed(ms) {
    this.speed = clamp(Number(ms) || DEFAULTS.speed, MIN_SPEED, MAX_SPEED);
  }

  /** Enable/disable toroidal edges. Takes effect on the next generation. */
  setWrap(wrap) {
    this.options.wrap = Boolean(wrap);
  }

  _tick(timestamp) {
    if (!this._running) return;

    if (!this._lastTick) this._lastTick = timestamp;
    this._accumulator += timestamp - this._lastTick;
    this._lastTick = timestamp;

    let steps = 0;
    while (this._accumulator >= this.speed && steps < 4) {
      this._advance();
      this._accumulator -= this.speed;
      steps += 1;
    }
    if (steps === 4) this._accumulator = 0; // drop backlog after a stall

    if (steps > 0) {
      this._draw();
      this._notify();
    }

    this._raf = requestAnimationFrame(this._tick);
  }

  _advance() {
    const { cols, rows } = this;
    const grid = this.grid;
    const next = this._next;
    const wrap = Boolean(this.options.wrap);

    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        let neighbours = 0;

        for (let dy = -1; dy <= 1; dy += 1) {
          const ny = wrap ? (y + dy + rows) % rows : y + dy;
          if (ny < 0 || ny >= rows) continue;

          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = wrap ? (x + dx + cols) % cols : x + dx;
            if (nx < 0 || nx >= cols) continue;
            neighbours += grid[ny * cols + nx];
          }
        }

        const i = y * cols + x;
        next[i] = grid[i]
          ? neighbours === 2 || neighbours === 3
            ? 1
            : 0
          : neighbours === 3
            ? 1
            : 0;
      }
    }

    this.grid = next;
    this._next = grid;
    this.generation += 1;
  }

  /* ------------------------------------------------------------------ *
   * Grid editing
   * ------------------------------------------------------------------ */

  /** Remove every cell and reset the generation counter. */
  clear() {
    this.grid.fill(0);
    this.generation = 0;
    this._draw();
    this._notify();
  }

  /** Fill the grid randomly. @param {number} [density] 0..1, default 0.3 */
  randomize(density = 0.3) {
    const chance = clamp(Number(density) || 0, 0, 1);
    for (let i = 0; i < this.grid.length; i += 1) {
      this.grid[i] = Math.random() < chance ? 1 : 0;
    }
    this.generation = 0;
    this._draw();
    this._notify();
  }

  getCell(x, y) {
    if (!this._inBounds(x, y)) return false;
    return this.grid[y * this.cols + x] === 1;
  }

  setCell(x, y, alive) {
    if (!this._inBounds(x, y)) return;
    const i = y * this.cols + x;
    const value = alive ? 1 : 0;
    if (this.grid[i] === value) return;
    this.grid[i] = value;
    this._draw();
    this._notify();
  }

  toggleCell(x, y) {
    if (!this._inBounds(x, y)) return;
    this.setCell(x, y, !this.getCell(x, y));
  }

  /**
   * Load a pattern, replacing the whole grid. Accepts pattern text (plaintext
   * or RLE) or a { width, height, data } object. Returns the parsed pattern.
   *
   * @param {string | { width: number, height: number, data: ArrayLike<number> }} input
   * @param {{ center?: boolean, x?: number, y?: number }} [options]
   */
  loadPattern(input, options = {}) {
    const pattern = normalizePattern(input); // parse before clearing, so bad input keeps the grid
    const { center = true } = options;

    let originX;
    let originY;
    if (Number.isFinite(options.x) && Number.isFinite(options.y)) {
      originX = Math.trunc(options.x);
      originY = Math.trunc(options.y);
    } else if (center) {
      originX = Math.floor((this.cols - pattern.width) / 2);
      originY = Math.floor((this.rows - pattern.height) / 2);
    } else {
      originX = 0;
      originY = 0;
    }

    this.grid.fill(0);
    this.generation = 0;
    this._place(pattern, originX, originY);
    this._draw();
    this._notify();
    return pattern;
  }

  /** Add a pattern to the grid without clearing it. */
  placePattern(input, x = 0, y = 0) {
    const pattern = normalizePattern(input);
    this._place(pattern, Math.trunc(x), Math.trunc(y));
    this._draw();
    this._notify();
    return pattern;
  }

  /** Fetch a pattern file and load it. */
  async loadPatternFromURL(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load pattern "${url}" (HTTP ${response.status}).`);
    }
    return this.loadPattern(await response.text());
  }

  _place(pattern, originX, originY) {
    let clipped = 0;
    for (let py = 0; py < pattern.height; py += 1) {
      const y = originY + py;
      for (let px = 0; px < pattern.width; px += 1) {
        if (!pattern.data[py * pattern.width + px]) continue;
        const x = originX + px;
        if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) {
          clipped += 1;
          continue;
        }
        this.grid[y * this.cols + x] = 1;
      }
    }
    if (clipped > 0) {
      console.warn(
        `GameOfLife: ${clipped} cell(s) fell outside the ${this.cols}x${this.rows} grid and were clipped.`,
      );
    }
  }

  /* ------------------------------------------------------------------ *
   * Stats, rendering, teardown
   * ------------------------------------------------------------------ */

  stats() {
    let population = 0;
    for (let i = 0; i < this.grid.length; i += 1) population += this.grid[i];
    return {
      generation: this.generation,
      population,
      running: this._running,
      cols: this.cols,
      rows: this.rows,
    };
  }

  _notify() {
    if (typeof this.options.onUpdate === 'function') {
      this.options.onUpdate(this.stats());
    }
  }

  _inBounds(x, y) {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }

  _sizeCanvas() {
    const width = this.cols * this.cellSize;
    const height = this.rows * this.cellSize;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);

    const style = this.canvas.style;
    style.display = 'block';
    style.cursor = this.options.interactive ? 'crosshair' : 'default';
    style.touchAction = 'none';

    if (this.options.responsive) {
      style.width = '100%';
      style.maxWidth = `${width}px`;
      style.height = 'auto';
    } else {
      style.width = `${width}px`;
      style.height = `${height}px`;
    }

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _draw() {
    const { ctx, cols, rows, cellSize } = this;
    const width = cols * cellSize;
    const height = rows * cellSize;

    ctx.fillStyle = this.options.background;
    ctx.fillRect(0, 0, width, height);

    if (this.options.gridColor) {
      ctx.strokeStyle = this.options.gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= cols; x += 1) {
        const px = x * cellSize + 0.5;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, height);
      }
      for (let y = 0; y <= rows; y += 1) {
        const py = y * cellSize + 0.5;
        ctx.moveTo(0, py);
        ctx.lineTo(width, py);
      }
      ctx.stroke();
    }

    const inset = cellSize >= 6 ? 1 : 0;
    const size = cellSize - inset;
    const offset = inset / 2;
    ctx.fillStyle = this.options.cellColor;
    for (let y = 0; y < rows; y += 1) {
      const row = y * cols;
      for (let x = 0; x < cols; x += 1) {
        if (this.grid[row + x]) {
          ctx.fillRect(x * cellSize + offset, y * cellSize + offset, size, size);
        }
      }
    }
  }

  _bindPointerEvents() {
    const canvas = this.canvas;

    this._handlers = {
      pointerdown: (event) => {
        if (event.button !== 0) return;
        const cell = this._cellAt(event);
        if (!cell) return;
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch {
          // Capture is only an optimisation (keeps drags working outside the
          // canvas); browsers can reject it for pointers that are not active.
        }
        this._paint = this.getCell(cell.x, cell.y) ? 0 : 1;
        this.setCell(cell.x, cell.y, this._paint === 1);
        event.preventDefault();
      },
      pointermove: (event) => {
        if (this._paint === null) return;
        const cell = this._cellAt(event);
        if (!cell) return;
        this.setCell(cell.x, cell.y, this._paint === 1);
      },
      pointerup: () => {
        this._paint = null;
      },
      pointercancel: () => {
        this._paint = null;
      },
      contextmenu: (event) => event.preventDefault(),
    };

    for (const [type, handler] of Object.entries(this._handlers)) {
      canvas.addEventListener(type, handler);
    }
  }

  _unbindPointerEvents() {
    if (!this._handlers) return;
    for (const [type, handler] of Object.entries(this._handlers)) {
      this.canvas.removeEventListener(type, handler);
    }
    this._handlers = null;
  }

  _cellAt(event) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * this.cols);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * this.rows);
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return null;
    return { x, y };
  }

  /** Stop playback, remove listeners, and remove the canvas from the page. */
  destroy() {
    this.pause();
    this._unbindPointerEvents();
    this.canvas.remove();
    this._host = null;
  }
}

/* ---------------------------------------------------------------------- *
 * Pattern parsing
 * ---------------------------------------------------------------------- */

/**
 * Parse pattern text. Supports plaintext (.cells: "O" alive, "." dead,
 * "!" comments) and RLE (header "x = ..., y = ..." plus b/o/$/! data).
 * Returns { width, height, data: Uint8Array }.
 */
export function parsePattern(text) {
  const source = String(text).replace(/\r\n?/g, '\n');
  return parseRLE(source) ?? parsePlainText(source);
}

function parsePlainText(source) {
  const rows = [];
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('!')) continue; // comment or blank
    rows.push(trimmed);
  }

  if (rows.length === 0) {
    throw new Error('Pattern has no cells (expected rows made of "." and "O").');
  }

  const height = rows.length;
  let width = 0;
  for (const row of rows) width = Math.max(width, row.length);

  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = rows[y];
    for (let x = 0; x < row.length; x += 1) {
      if (ALIVE_CHARS.has(row[x])) data[y * width + x] = 1;
    }
  }

  return { width, height, data };
}

function parseRLE(source) {
  const lines = source.split('\n');
  const headerIndex = lines.findIndex((line) => /^\s*x\s*=/.test(line));
  if (headerIndex === -1) return null;

  const body = lines
    .slice(headerIndex + 1)
    .filter((line) => !line.trim().startsWith('#'))
    .join('');

  const live = [];
  let x = 0;
  let y = 0;
  let count = 0;
  let width = 0;
  let height = 0;
  let done = false;

  for (const ch of body) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;

    if (ch >= '0' && ch <= '9') {
      count = count * 10 + (ch.charCodeAt(0) - 48);
      continue;
    }

    const run = count || 1;
    count = 0;

    if (ch === 'b' || ch === '.') {
      x += run;
    } else if (ch === 'o') {
      for (let i = 0; i < run; i += 1) {
        live.push([x + i, y]);
        width = Math.max(width, x + i + 1);
        height = Math.max(height, y + 1);
      }
      x += run;
    } else if (ch === '$') {
      y += run;
      x = 0;
    } else if (ch === '!') {
      done = true;
    }

    if (done) break;
  }

  if (live.length === 0) {
    throw new Error('RLE pattern contains no live cells.');
  }

  const data = new Uint8Array(width * height);
  for (const [cx, cy] of live) data[cy * width + cx] = 1;
  return { width, height, data };
}

function normalizePattern(input) {
  const pattern = typeof input === 'string' ? parsePattern(input) : input;
  if (
    !pattern ||
    !Number.isInteger(pattern.width) ||
    !Number.isInteger(pattern.height) ||
    pattern.width <= 0 ||
    pattern.height <= 0 ||
    !pattern.data ||
    pattern.data.length < pattern.width * pattern.height
  ) {
    throw new TypeError('Pattern must be pattern text or { width, height, data } with positive dimensions.');
  }
  return pattern;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
