import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SatoriElement = { type: string; props: Record<string, unknown> };
type ResvgInstance = { render(): { asPng(): Uint8Array } };
type SatoriFontEntry = { name: string; data: Buffer; weight: number; style: string };

export type TableData = {
  headers: string[];
  aligns: Array<"left" | "center" | "right">;
  rows: string[][];
};

// ---------------------------------------------------------------------------
// Theme (GitHub-dark — fits Discord's dark UI)
// ---------------------------------------------------------------------------

const THEME = {
  bg: "#0d1117",
  headerBg: "#161b22",
  border: "#30363d",
  text: "#e6edf3",
  headerText: "#79c0ff",
  evenRowBg: "#161b22",
} as const;

const FONT_SIZE = 14;
const CELL_PAD_X = 16;
const CELL_PAD_Y = 10;
const MIN_COL_WIDTH = 60;
const CHAR_WIDTH = FONT_SIZE * 0.62;
const LINE_HEIGHT = FONT_SIZE * 1.4;

// Size guards — prevent OOM from absurdly large tables.
const MAX_TABLE_ROWS = 60;
const MAX_TABLE_COLS = 20;
const MAX_CELL_CHARS = 500;
const MAX_IMAGE_WIDTH = 2400;
const MAX_IMAGE_HEIGHT = 4000;

// ---------------------------------------------------------------------------
// Lazy-loaded modules + font cache
// ---------------------------------------------------------------------------

let _satori: ((el: SatoriElement, opts: Record<string, unknown>) => Promise<string>) | null = null;
let _Resvg: (new (svg: string, opts?: Record<string, unknown>) => ResvgInstance) | null = null;
let _fontsPromise: Promise<SatoriFontEntry[] | null> | null = null;

async function loadSatori() {
  if (_satori) {
    return _satori;
  }
  // Interop-safe: handle both ESM default and CJS shapes (same pattern as loadSharp in image-ops.ts)
  const mod = (await import("satori")) as unknown as Record<string, unknown>;
  _satori = (mod.default ?? mod) as unknown as typeof _satori;
  return _satori!;
}

async function loadResvg() {
  if (_Resvg) {
    return _Resvg;
  }
  const mod = (await import("@resvg/resvg-js")) as unknown as Record<string, unknown>;
  _Resvg = (mod.Resvg ?? mod.default ?? mod) as unknown as typeof _Resvg;
  return _Resvg!;
}

// ---------------------------------------------------------------------------
// Font loading — all bundled, no system font probing needed.
// ---------------------------------------------------------------------------

/** Bundled fonts: monospace primary + Noto fallbacks for symbols/scripts. */
const BUNDLED_FONTS = [
  { file: "NotoSansMono-Regular.ttf", name: "Mono", weight: 400 },
  { file: "NotoSans-Regular.ttf", name: "Noto Fallback", weight: 400 },
  { file: "NotoSansSymbols-Regular.ttf", name: "Noto Fallback", weight: 400 },
  { file: "NotoSansSymbols2-Regular.ttf", name: "Noto Fallback", weight: 400 },
];

function resolveFontsDir(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const fontsInSameDir = path.join(thisDir, "fonts");
  try {
    fsSync.accessSync(fontsInSameDir);
    return fontsInSameDir;
  } catch {
    return path.join(thisDir, "..", "fonts");
  }
}
const BUNDLED_FONTS_DIR = resolveFontsDir();

/** Load all bundled fonts. Cached as a promise to avoid concurrent races. */
function loadFonts(): Promise<SatoriFontEntry[] | null> {
  if (_fontsPromise) {
    return _fontsPromise;
  }
  _fontsPromise = (async () => {
    const entries: SatoriFontEntry[] = [];
    for (const { file, name, weight } of BUNDLED_FONTS) {
      try {
        const data = await fs.readFile(path.join(BUNDLED_FONTS_DIR, file));
        entries.push({ name, data, weight, style: "normal" });
      } catch {
        // skip missing font
      }
    }
    // Need at least the primary mono font.
    // Clear cache on failure so transient I/O errors don't permanently disable the renderer.
    if (entries.length === 0) {
      _fontsPromise = null;
      return null;
    }
    return entries;
  })();
  return _fontsPromise;
}

// ---------------------------------------------------------------------------
// GFM table parser
// ---------------------------------------------------------------------------

const SEPARATOR_RE = /^\|?\s*[-:]+[-| :]*\|?\s*$/;

/** Split a table row on unescaped pipes, handling `\|` as a literal pipe.
 *  `\\|` produces a literal backslash + pipe delimiter (even count of backslashes). */
function parseLine(line: string): string[] {
  const stripped = line.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === "\\") {
      // Count consecutive backslashes
      let bsCount = 0;
      while (i + bsCount < stripped.length && stripped[i + bsCount] === "\\") {
        bsCount++;
      }
      const nextChar = i + bsCount < stripped.length ? stripped[i + bsCount] : "";
      if (nextChar === "|" && bsCount % 2 === 1) {
        // Odd backslashes before pipe: emit floor(bsCount/2) literal backslashes + literal pipe
        current += "\\".repeat(Math.floor(bsCount / 2)) + "|";
        i += bsCount; // skip past the pipe (loop increments i once more)
      } else if (nextChar === "|") {
        // Even backslashes before pipe: collapse pairs, pipe is a delimiter
        current += "\\".repeat(bsCount / 2);
        i += bsCount - 1; // position on last backslash; loop increments, then pipe hits delimiter branch
      } else {
        // Backslashes not followed by pipe: collapse pairs (GFM escape semantics)
        current += "\\".repeat(Math.ceil(bsCount / 2));
        i += bsCount - 1;
      }
    } else if (stripped[i] === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += stripped[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

/** Parse a GFM pipe-table into structured data, or null if invalid/too large. */
export function parseGfmTable(markdown: string): TableData | null {
  const lines = markdown.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2 || !SEPARATOR_RE.test(lines[1])) {
    return null;
  }

  const headers = parseLine(lines[0]);
  if (headers.length > MAX_TABLE_COLS) {
    return null;
  }

  const colCount = headers.length;
  const aligns: Array<"left" | "center" | "right"> = parseLine(lines[1]).map((cell) => {
    const t = cell.trim();
    if (t.startsWith(":") && t.endsWith(":")) {
      return "center";
    }
    if (t.endsWith(":")) {
      return "right";
    }
    return "left";
  });

  const rawRows = lines.slice(2).filter((l) => !SEPARATOR_RE.test(l));
  if (rawRows.length > MAX_TABLE_ROWS) {
    return null;
  }

  const rows = rawRows.map((l) => {
    const cells = parseLine(l);
    return Array.from({ length: colCount }, (_, i) => {
      const cell = cells[i] ?? "";
      return cell.length > MAX_CELL_CHARS ? `${cell.slice(0, MAX_CELL_CHARS)}…` : cell;
    });
  });

  return { headers, aligns, rows };
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function stripInline(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/gs, "$1")
    .replace(/\*(.*?)\*/gs, "$1")
    .replace(/__(.*?)__/gs, "$1")
    .replace(/_(.*?)_/gs, "$1")
    .replace(/~~(.*?)~~/gs, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function estimateColWidths(table: TableData): number[] {
  const widths: number[] = Array(table.headers.length).fill(MIN_COL_WIDTH) as number[];
  for (let c = 0; c < table.headers.length; c++) {
    for (const row of [table.headers, ...table.rows]) {
      const w = stripInline(row[c] ?? "").length * CHAR_WIDTH + CELL_PAD_X * 2;
      if (w > widths[c]) {
        widths[c] = w;
      }
    }
  }
  return widths;
}

function estimateRowHeight(cells: string[], colWidths: number[]): number {
  let maxLines = 1;
  for (let i = 0; i < cells.length; i++) {
    const usable = Math.max((colWidths[i] ?? MIN_COL_WIDTH) - CELL_PAD_X * 2, CHAR_WIDTH);
    const lines = Math.max(
      1,
      Math.ceil(stripInline(cells[i] ?? "").length / Math.floor(usable / CHAR_WIDTH)),
    );
    if (lines > maxLines) {
      maxLines = lines;
    }
  }
  return maxLines * LINE_HEIGHT + CELL_PAD_Y * 2;
}

function estimateTableHeight(table: TableData, colWidths: number[]): number {
  let h = estimateRowHeight(table.headers, colWidths) + 2;
  for (const row of table.rows) {
    h += estimateRowHeight(row, colWidths) + 1;
  }
  return Math.max(Math.ceil(h + 10), 60);
}

// ---------------------------------------------------------------------------
// Satori element tree builder
// ---------------------------------------------------------------------------

function buildCell(
  text: string,
  colIndex: number,
  colCount: number,
  colWidths: number[],
  align: "left" | "center" | "right",
  isHeader: boolean,
): SatoriElement {
  const justify = align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start";
  // Satori crashes on undefined style values, so conditionally add borderRight.
  const style: Record<string, unknown> = {
    width: `${colWidths[colIndex]}px`,
    padding: `${CELL_PAD_Y}px ${CELL_PAD_X}px`,
    fontSize: FONT_SIZE,
    fontFamily: "Mono",
    fontWeight: isHeader ? 700 : 400,
    color: isHeader ? THEME.headerText : THEME.text,
    display: "flex",
    alignItems: "center",
    justifyContent: justify,
  };
  if (colIndex < colCount - 1) {
    style.borderRight = `1px solid ${THEME.border}`;
  }
  return { type: "div", props: { style, children: stripInline(text) } };
}

function buildTableElement(table: TableData, colWidths: number[]): SatoriElement {
  const colCount = table.headers.length;
  const headerRow: SatoriElement = {
    type: "div",
    props: {
      style: {
        display: "flex",
        backgroundColor: THEME.headerBg,
        borderBottom: `2px solid ${THEME.border}`,
      },
      children: table.headers.map((h, i) =>
        buildCell(h, i, colCount, colWidths, table.aligns[i] ?? "left", true),
      ),
    },
  };
  const bodyRows = table.rows.map(
    (row, rowIdx): SatoriElement => ({
      type: "div",
      props: {
        style: {
          display: "flex",
          backgroundColor: rowIdx % 2 === 0 ? THEME.bg : THEME.evenRowBg,
          borderBottom: `1px solid ${THEME.border}`,
        },
        children: row
          .slice(0, colCount)
          .map((cell, i) =>
            buildCell(cell, i, colCount, colWidths, table.aligns[i] ?? "left", false),
          ),
      },
    }),
  );
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column",
        backgroundColor: THEME.bg,
        border: `1px solid ${THEME.border}`,
        borderRadius: 8,
        overflow: "hidden",
      },
      children: [headerRow, ...bodyRows],
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a GFM markdown table to a PNG buffer.
 * Returns null when renderer is unavailable or table is invalid — callers
 * should fall back to text delivery.
 */
export async function renderTableImage(tableMarkdown: string): Promise<Buffer | null> {
  try {
    const table = parseGfmTable(tableMarkdown);
    if (!table) {
      return null;
    }
    const [satori, Resvg, fonts] = await Promise.all([loadSatori(), loadResvg(), loadFonts()]);
    if (!fonts) {
      return null;
    }

    const colWidths = estimateColWidths(table);
    const totalWidth = Math.min(
      Math.max(colWidths.reduce((a, b) => a + b, 0) + 2, 200),
      MAX_IMAGE_WIDTH,
    );
    const totalHeight = Math.min(estimateTableHeight(table, colWidths), MAX_IMAGE_HEIGHT);

    const svg = await satori(buildTableElement(table, colWidths), {
      width: totalWidth,
      height: totalHeight,
      fonts,
    });

    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: totalWidth } });
    return Buffer.from(resvg.render().asPng());
  } catch {
    return null;
  }
}
