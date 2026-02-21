import fsSync from "node:fs";
import fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SatoriElement = {
  type: string;
  props: Record<string, unknown>;
};

export type TableData = {
  headers: string[];
  aligns: Array<"left" | "center" | "right">;
  rows: string[][];
};

export type TableImageResult = {
  png: Buffer;
  fileName: string;
  fallbackMarkdown: string;
};

// ---------------------------------------------------------------------------
// Theme (GitHub-dark palette — fits Discord's dark UI)
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
/** Approximate width of one monospace character at FONT_SIZE. */
const CHAR_WIDTH = FONT_SIZE * 0.62;

// ---------------------------------------------------------------------------
// Lazy-loaded modules + font cache
// ---------------------------------------------------------------------------

let _satori: ((element: SatoriElement, opts: Record<string, unknown>) => Promise<string>) | null =
  null;
let _Resvg: (new (svg: string, opts?: Record<string, unknown>) => ResvgInstance) | null = null;
let _fontData: Buffer | null = null;
let _fontBoldData: Buffer | null = null;
let _fallbackFontsData: Buffer[] | null = null;
let _fallbackFontsLoaded = false;
let _rendererAvailable: boolean | null = null;

/** In-memory cache for fetched Twemoji SVGs (keyed by codepoint string). */
const _emojiCache = new Map<string, string | null>();

type ResvgInstance = {
  render(): { asPng(): Uint8Array };
};

// ---------------------------------------------------------------------------
// Cross-platform monospace font discovery
// ---------------------------------------------------------------------------

const FONT_PATHS: Record<string, string[]> = {
  linux: [
    "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
    "/usr/share/fonts/truetype/ubuntu/UbuntuMono-R.ttf",
  ],
  darwin: [
    "/System/Library/Fonts/SFMono-Regular.otf",
    "/Library/Fonts/SF-Mono-Regular.otf",
    "/System/Library/Fonts/Courier New.ttf",
  ],
  win32: ["C:\\Windows\\Fonts\\consola.ttf", "C:\\Windows\\Fonts\\cour.ttf"],
};

const FONT_BOLD_PATHS: Record<string, string[]> = {
  linux: [
    "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
    "/usr/share/fonts/truetype/ubuntu/UbuntuMono-B.ttf",
  ],
  darwin: ["/System/Library/Fonts/SFMono-Bold.otf", "/Library/Fonts/SF-Mono-Bold.otf"],
  win32: ["C:\\Windows\\Fonts\\consolab.ttf", "C:\\Windows\\Fonts\\courbd.ttf"],
};

async function findFont(paths: string[]): Promise<Buffer | null> {
  for (const p of paths) {
    try {
      return await fs.readFile(p);
    } catch {
      continue;
    }
  }
  return null;
}

/** Bundled fallback fonts for broad Unicode coverage (Noto Sans family). */
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve fonts dir relative to the built entry point (dist/fonts/).
// In dev (bun/tsx), import.meta.url points to the source file, so we
// resolve from the project root instead.
function resolveFontsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  // Built code lives in dist/entry.js → fonts at dist/fonts/
  // Source code lives in src/media/table-image.ts → fonts at src/media/fonts/
  const fontsInSameDir = path.join(thisDir, "fonts");
  try {
    fsSync.accessSync(fontsInSameDir);
    return fontsInSameDir;
  } catch {
    // Fallback: try dist/fonts relative to the entry point
    return path.join(thisDir, "..", "fonts");
  }
}
const BUNDLED_FONTS_DIR = resolveFontsDir();

async function loadFonts(): Promise<{ regular: Buffer; bold: Buffer | null } | null> {
  if (_fontData) {
    return { regular: _fontData, bold: _fontBoldData };
  }

  // Honour env override
  const envFont = process.env.OPENCLAW_TABLE_FONT;
  if (envFont) {
    try {
      _fontData = await fs.readFile(envFont);
      _fontBoldData = null;
      return { regular: _fontData, bold: null };
    } catch {
      // fall through to platform search
    }
  }

  const platform = process.platform;
  const regular = await findFont(FONT_PATHS[platform] ?? FONT_PATHS.linux);
  if (!regular) {
    return null;
  }

  _fontData = regular;
  _fontBoldData = await findFont(FONT_BOLD_PATHS[platform] ?? FONT_BOLD_PATHS.linux);
  return { regular: _fontData, bold: _fontBoldData };
}

async function loadSatori() {
  if (_satori) {
    return _satori;
  }
  const mod = (await import("satori")) as unknown as { default: typeof _satori };
  _satori = mod.default;
  return _satori!;
}

async function loadResvg() {
  if (_Resvg) {
    return _Resvg;
  }
  const mod = (await import("@resvg/resvg-js")) as unknown as { Resvg: typeof _Resvg };
  _Resvg = mod.Resvg;
  return _Resvg!;
}

// ---------------------------------------------------------------------------
// Emoji & missing glyph support (loadAdditionalAsset callback for satori)
// ---------------------------------------------------------------------------

const TWEMOJI_BASE = "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/";

/** Convert an emoji grapheme cluster to its Twemoji SVG filename. */
function emojiToCodepoints(emoji: string): string {
  const codepoints: string[] = [];
  for (let i = 0; i < emoji.length; ) {
    const cp = emoji.codePointAt(i)!;
    codepoints.push(cp.toString(16));
    i += cp > 0xffff ? 2 : 1;
  }
  return codepoints.filter((cp) => cp !== "fe0f").join("-");
}

/** Fetch a Twemoji SVG and return as data URL, or null on failure. */
async function fetchTwemojiSvg(codepoints: string): Promise<string | null> {
  const cached = _emojiCache.get(codepoints);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const url = `${TWEMOJI_BASE}${codepoints}.svg`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      _emojiCache.set(codepoints, null);
      return null;
    }
    const svgText = await res.text();
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svgText).toString("base64")}`;
    _emojiCache.set(codepoints, dataUrl);
    return dataUrl;
  } catch {
    _emojiCache.set(codepoints, null);
    return null;
  }
}

const BUNDLED_FALLBACK_FONTS = [
  "NotoSans-Regular.ttf",
  "NotoSansSymbols-Regular.ttf",
  "NotoSansSymbols2-Regular.ttf",
];

/** Load bundled Noto Sans fallback fonts for missing glyphs. */
async function loadFallbackFonts(): Promise<Buffer[]> {
  if (_fallbackFontsLoaded) {
    return _fallbackFontsData ?? [];
  }
  _fallbackFontsLoaded = true;
  const fonts: Buffer[] = [];
  for (const name of BUNDLED_FALLBACK_FONTS) {
    try {
      const fontPath = path.join(BUNDLED_FONTS_DIR, name);
      fonts.push(await fs.readFile(fontPath));
    } catch {
      // Skip missing fonts gracefully
    }
  }
  _fallbackFontsData = fonts.length > 0 ? fonts : null;
  return fonts;
}

type FontOptions = { name: string; data: Buffer; weight: number; style: string };

/**
 * Satori `loadAdditionalAsset` callback — handles emojis via Twemoji CDN
 * and missing glyphs via a system fallback font (Noto Sans).
 */
async function loadAdditionalAsset(
  code: string,
  segment: string,
): Promise<string | FontOptions[] | undefined> {
  if (code === "emoji") {
    // Satori passes individual grapheme clusters for emojis
    const codepoints = emojiToCodepoints(segment);
    const svg = await fetchTwemojiSvg(codepoints);
    return svg ?? undefined;
  }

  // For other missing glyphs (symbols, scripts, math), use bundled Noto fonts
  const fallbacks = await loadFallbackFonts();
  if (fallbacks.length > 0) {
    return fallbacks.map((data) => ({ name: "Noto Fallback", data, weight: 400, style: "normal" }));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Renderer availability
// ---------------------------------------------------------------------------

/** Returns true when satori, resvg, and at least one font are loadable. */
export async function isTableImageRendererAvailable(): Promise<boolean> {
  if (_rendererAvailable !== null) {
    return _rendererAvailable;
  }
  try {
    const [fonts] = await Promise.all([loadFonts(), loadSatori(), loadResvg()]);
    _rendererAvailable = fonts !== null;
  } catch {
    _rendererAvailable = false;
  }
  return _rendererAvailable;
}

// ---------------------------------------------------------------------------
// GFM table parser (regex-based — fast & simple)
// ---------------------------------------------------------------------------

const SEPARATOR_RE = /^\|?\s*[-:]+[-| :]*\|?\s*$/;

function parseLine(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Parse a GFM pipe-table into structured data, or null if not a valid table. */
export function parseGfmTable(markdown: string): TableData | null {
  const lines = markdown.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2 || !SEPARATOR_RE.test(lines[1])) {
    return null;
  }

  const headers = parseLine(lines[0]);
  const separatorCells = parseLine(lines[1]);

  const aligns: Array<"left" | "center" | "right"> = separatorCells.map((cell) => {
    const t = cell.trim();
    if (t.startsWith(":") && t.endsWith(":")) {
      return "center";
    }
    if (t.endsWith(":")) {
      return "right";
    }
    return "left";
  });

  const rows = lines
    .slice(2)
    .filter((l) => !SEPARATOR_RE.test(l))
    .map(parseLine);

  return { headers, aligns, rows };
}

// ---------------------------------------------------------------------------
// Inline markdown stripping (for clean canvas text)
// ---------------------------------------------------------------------------

function stripInline(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/gs, "$1") // bold
    .replace(/\*(.*?)\*/gs, "$1") // italic
    .replace(/__(.*?)__/gs, "$1") // bold alt
    .replace(/_(.*?)_/gs, "$1") // italic alt
    .replace(/~~(.*?)~~/gs, "$1") // strikethrough
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → label
    .trim();
}

// ---------------------------------------------------------------------------
// Column width estimation
// ---------------------------------------------------------------------------

function estimateColWidths(table: TableData): number[] {
  const colCount = table.headers.length;
  const widths: number[] = Array(colCount).fill(MIN_COL_WIDTH) as number[];
  const allRows = [table.headers, ...table.rows];

  for (let c = 0; c < colCount; c++) {
    for (const row of allRows) {
      const cell = stripInline(row[c] ?? "");
      const w = cell.length * CHAR_WIDTH + CELL_PAD_X * 2;
      if (w > widths[c]) {
        widths[c] = w;
      }
    }
  }
  return widths;
}

// ---------------------------------------------------------------------------
// Height estimation (accounts for text wrapping in cells)
// ---------------------------------------------------------------------------

const LINE_HEIGHT = FONT_SIZE * 1.4;

/** Estimate wrapped line count for a cell string at a given column width. */
function estimateWrappedLines(text: string, colWidth: number): number {
  const usable = Math.max(colWidth - CELL_PAD_X * 2, CHAR_WIDTH);
  const charsPerLine = Math.floor(usable / CHAR_WIDTH);
  if (charsPerLine <= 0) {
    return 1;
  }
  const stripped = stripInline(text);
  return Math.max(1, Math.ceil(stripped.length / charsPerLine));
}

/** Estimate the pixel height of a single row (max wrapped lines across all cells). */
function estimateRowHeight(cells: string[], colWidths: number[]): number {
  let maxLines = 1;
  for (let i = 0; i < cells.length; i++) {
    const lines = estimateWrappedLines(cells[i] ?? "", colWidths[i] ?? MIN_COL_WIDTH);
    if (lines > maxLines) {
      maxLines = lines;
    }
  }
  return maxLines * LINE_HEIGHT + CELL_PAD_Y * 2;
}

function estimateTableHeight(table: TableData, colWidths: number[]): number {
  const headerH = estimateRowHeight(table.headers, colWidths) + 2; // 2px bottom border
  let bodyH = 0;
  for (const row of table.rows) {
    bodyH += estimateRowHeight(row, colWidths) + 1; // 1px bottom border
  }
  // +2 for outer container border (1px top + 1px bottom), +8 for safety margin
  return Math.max(Math.ceil(headerH + bodyH + 2 + 8), 60);
}

// ---------------------------------------------------------------------------
// Satori element tree builder (React.createElement-compatible objects)
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
  // Satori crashes on `undefined` style values (.trim() on undefined), so
  // only include borderRight when it has an actual value.
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
  return {
    type: "div",
    props: { style, children: stripInline(text) },
  };
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
 * Render a GFM markdown table to a PNG image.
 *
 * Returns `null` when the renderer is unavailable or the table cannot be
 * parsed — callers should fall back to text delivery.
 */
export async function renderTableImage(
  tableMarkdown: string,
  index: number,
): Promise<TableImageResult | null> {
  const available = await isTableImageRendererAvailable();
  if (!available) {
    return null;
  }

  const table = parseGfmTable(tableMarkdown);
  if (!table) {
    return null;
  }

  try {
    const satori = await loadSatori();
    const Resvg = await loadResvg();
    const fonts = await loadFonts();
    if (!fonts) {
      return null;
    }

    const colWidths = estimateColWidths(table);
    const totalWidth = Math.max(colWidths.reduce((a, b) => a + b, 0) + 2, 200);
    const totalHeight = estimateTableHeight(table, colWidths);

    const element = buildTableElement(table, colWidths);

    const fontEntries: Array<{
      name: string;
      data: Buffer;
      weight: 400 | 700;
      style: "normal";
    }> = [{ name: "Mono", data: fonts.regular, weight: 400, style: "normal" }];
    if (fonts.bold) {
      fontEntries.push({ name: "Mono", data: fonts.bold, weight: 700, style: "normal" });
    }

    const svg = await satori(element, {
      width: totalWidth,
      height: totalHeight,
      fonts: fontEntries,
      loadAdditionalAsset,
    });

    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: totalWidth },
    });
    const pngBytes = resvg.render().asPng();

    return {
      png: Buffer.from(pngBytes),
      fileName: `table-${index + 1}.png`,
      fallbackMarkdown: tableMarkdown,
    };
  } catch {
    return null;
  }
}
