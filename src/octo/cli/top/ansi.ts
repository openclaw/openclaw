// Octopus Orchestrator — ANSI terminal utilities for `octo top`
//
// Zero-dependency terminal rendering primitives. All output goes through
// these helpers to keep the TUI code clean and testable.
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

// ──────────────────────────────────────────────────────────────────────────
// Escape sequences
// ──────────────────────────────────────────────────────────────────────────

export const ESC = "\x1b[";
export const CLEAR_SCREEN = ESC + "2J";
export const CURSOR_HOME = ESC + "H";
export const CURSOR_HIDE = ESC + "?25l";
export const CURSOR_SHOW = ESC + "?25h";
export const CLEAR_LINE = ESC + "2K";
export const RESET = ESC + "0m";

// ──────────────────────────────────────────────────────────────────────────
// Colors
// ──────────────────────────────────────────────────────────────────────────

export const fg = {
  black: (s: string) => ESC + "30m" + s + RESET,
  red: (s: string) => ESC + "31m" + s + RESET,
  green: (s: string) => ESC + "32m" + s + RESET,
  yellow: (s: string) => ESC + "33m" + s + RESET,
  blue: (s: string) => ESC + "34m" + s + RESET,
  magenta: (s: string) => ESC + "35m" + s + RESET,
  cyan: (s: string) => ESC + "36m" + s + RESET,
  white: (s: string) => ESC + "37m" + s + RESET,
  gray: (s: string) => ESC + "90m" + s + RESET,
  brightGreen: (s: string) => ESC + "92m" + s + RESET,
  brightYellow: (s: string) => ESC + "93m" + s + RESET,
  brightCyan: (s: string) => ESC + "96m" + s + RESET,
};

export const bg = {
  black: (s: string) => ESC + "40m" + s + RESET,
  blue: (s: string) => ESC + "44m" + s + RESET,
  white: (s: string) => ESC + "47m" + s + RESET,
  gray: (s: string) => ESC + "100m" + s + RESET,
};

export const style = {
  bold: (s: string) => ESC + "1m" + s + RESET,
  dim: (s: string) => ESC + "2m" + s + RESET,
  underline: (s: string) => ESC + "4m" + s + RESET,
  inverse: (s: string) => ESC + "7m" + s + RESET,
};

// ──────────────────────────────────────────────────────────────────────────
// Cursor positioning
// ──────────────────────────────────────────────────────────────────────────

export function moveTo(row: number, col: number): string {
  return ESC + row + ";" + col + "H";
}

// ──────────────────────────────────────────────────────────────────────────
// Layout helpers
// ──────────────────────────────────────────────────────────────────────────

/** Strip ANSI escape codes for accurate string length measurement. */
export function stripAnsiLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").length;
}

/** Pad or truncate a string to exactly `width` visible characters. */
export function padRight(s: string, width: number): string {
  const visible = stripAnsiLen(s);
  if (visible >= width) {
    // Truncate — need to be careful with ANSI codes
    let count = 0;
    let i = 0;
    while (i < s.length && count < width - 1) {
      if (s[i] === "\x1b") {
        // Skip entire escape sequence
        const end = s.indexOf("m", i);
        if (end !== -1) {
          i = end + 1;
          continue;
        }
      }
      count++;
      i++;
    }
    return s.slice(0, i) + RESET + "\u2026";
  }
  return s + " ".repeat(width - visible);
}

/** Center a string within `width` visible characters. */
export function center(s: string, width: number): string {
  const visible = stripAnsiLen(s);
  if (visible >= width) {
    return s;
  }
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return " ".repeat(left) + s + " ".repeat(right);
}

/** Draw a horizontal rule. */
export function hr(width: number, char = "\u2500"): string {
  return char.repeat(width);
}

// ──────────────────────────────────────────────────────────────────────────
// Sparkline
// ──────────────────────────────────────────────────────────────────────────

const SPARK_CHARS = [
  "\u2581",
  "\u2582",
  "\u2583",
  "\u2584",
  "\u2585",
  "\u2586",
  "\u2587",
  "\u2588",
];

/** Render a sparkline from an array of values (0-1 normalized). */
export function sparkline(values: number[], width: number): string {
  const normalized = values.slice(-width);
  return normalized
    .map((v) => {
      const clamped = Math.max(0, Math.min(1, v));
      const idx = Math.round(clamped * (SPARK_CHARS.length - 1));
      return SPARK_CHARS[idx];
    })
    .join("");
}

// ──────────────────────────────────────────────────────────────────────────
// Status indicators
// ──────────────────────────────────────────────────────────────────────────

export function statusBadge(state: string): string {
  switch (state) {
    case "active":
    case "running":
      return fg.brightGreen("\u25cf " + state);
    case "spawning":
    case "queued":
      return fg.brightYellow("\u25cb " + state);
    case "paused":
    case "blocked":
      return fg.yellow("\u25d0 " + state);
    case "completed":
    case "done":
      return fg.green("\u2714 " + state);
    case "aborted":
    case "terminated":
    case "failed":
      return fg.red("\u2718 " + state);
    default:
      return fg.gray("\u25cb " + state);
  }
}

/** Progress bar: [=====>    ] 55% */
export function progressBar(fraction: number, width: number): string {
  const inner = width - 2; // subtract brackets
  const filled = Math.round(fraction * inner);
  const empty = inner - filled;
  const pct = (fraction * 100).toFixed(0) + "%";
  return (
    fg.gray("[") +
    fg.green("\u2588".repeat(filled)) +
    fg.gray("\u2591".repeat(empty)) +
    fg.gray("]") +
    " " +
    pct
  );
}
