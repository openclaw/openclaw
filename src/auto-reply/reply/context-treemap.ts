import crypto from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { estimateTokensFromChars } from "@openclaw/normalization-core/cjk-chars";
import type { SessionSystemPromptReport } from "../../config/sessions/types.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { encodePngRgba } from "../../media/png-encode.js";

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Rgb = {
  r: number;
  g: number;
  b: number;
};

type TreemapLeaf = {
  name: string;
  value: number;
};

type TreemapGroup = {
  name: string;
  value: number;
  color: Rgb;
  leaves: TreemapLeaf[];
};

type PositionedItem<T> = {
  item: T;
  rect: Rect;
};

type ContextTreemapSessionStats = {
  cachedContextTokens: number | null;
  contextWindowTokens: number | null;
};

const WIDTH = 1280;
const HEIGHT = 860;
const HEADER_HEIGHT = 88;
const FOOTER_HEIGHT = 54;
const LEGEND_WIDTH = 274;
const PADDING = 22;
const TREEMAP_GAP = 4;

const FONT: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  _: ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00001", "00001", "00001", "00001", "10001", "10001", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

function rgb(r: number, g: number, b: number): Rgb {
  return { r, g, b };
}

function mixColor(a: Rgb, b: Rgb, amount: number): Rgb {
  const t = Math.max(0, Math.min(1, amount));
  return rgb(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
}

const numberFormat = new Intl.NumberFormat("en-US");
const formatInt = (value: number) => numberFormat.format(value);

function formatSize(value: number): string {
  return `${formatInt(value)} CH / ~${formatInt(estimateTokensFromChars(value))} TOK`;
}

function totalValue(items: Array<{ value: number }>): number {
  return items.reduce((sum, item) => sum + item.value, 0);
}

function sanitizeLabel(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9/_.:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function layoutBinary<T extends { value: number }>(
  rawItems: T[],
  bounds: Rect,
): PositionedItem<T>[] {
  const items = rawItems.filter((item) => item.value > 0).toSorted((a, b) => b.value - a.value);
  const positioned: PositionedItem<T>[] = [];
  // Child ranges retain the stable descending order; sum each range from zero
  // to preserve floating-point split decisions and pixel boundaries.
  function visit(start: number, end: number, rect: Rect): void {
    if (start === end || rect.width <= 0 || rect.height <= 0) {
      return;
    }
    if (end - start === 1) {
      positioned.push({ item: expectDefined(items[start], "items entry at start"), rect });
      return;
    }
    let total = 0;
    for (let i = start; i < end; i += 1) {
      total += expectDefined(items[i], "items entry at i").value;
    }
    let splitIndex = start + 1;
    let splitSum = items[start]?.value ?? 0;
    for (let i = start + 1; i < end - 1; i += 1) {
      const next = splitSum + expectDefined(items[i], "items entry at i").value;
      if (Math.abs(total / 2 - next) > Math.abs(total / 2 - splitSum)) {
        break;
      }
      splitSum = next;
      splitIndex = i + 1;
    }
    const ratio = splitSum / total;
    const dimension = rect.width >= rect.height ? "width" : "height";
    const position = dimension === "width" ? "x" : "y";
    const firstSize = rect[dimension] * ratio;
    visit(start, splitIndex, { ...rect, [dimension]: firstSize });
    visit(splitIndex, end, {
      ...rect,
      [position]: rect[position] + firstSize,
      [dimension]: rect[dimension] - firstSize,
    });
  }
  visit(0, items.length, bounds);
  return positioned;
}

/** Tiny in-process RGBA canvas used to avoid runtime image dependencies. */
class PngCanvas {
  readonly data = Buffer.alloc(WIDTH * HEIGHT * 4);

  rect(rect: Rect, color: Rgb): void {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(WIDTH, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(HEIGHT, Math.ceil(rect.y + rect.height));
    if (!(x1 > x0 && y1 > y0)) {
      return;
    }
    const pixel = Buffer.from([color.r, color.g, color.b, 255]);
    for (let y = y0; y < y1; y += 1) {
      this.data.fill(pixel, (y * WIDTH + x0) * 4, (y * WIDTH + x1) * 4);
    }
  }

  stroke(rect: Rect, color: Rgb, width: number): void {
    this.rect({ x: rect.x, y: rect.y, width: rect.width, height: width }, color);
    this.rect(
      { x: rect.x, y: rect.y + rect.height - width, width: rect.width, height: width },
      color,
    );
    this.rect({ x: rect.x, y: rect.y, width, height: rect.height }, color);
    this.rect({ x: rect.x + rect.width - width, y: rect.y, width, height: rect.height }, color);
  }

  text(x: number, y: number, text: string, color: Rgb, scale: number): void {
    let cursorX = Math.floor(x);
    const cursorY = Math.floor(y);
    for (const rawChar of text) {
      const char = rawChar.toUpperCase();
      const glyph = expectDefined(FONT[char] ?? FONT[" "], "treemap font glyph");
      for (let row = 0; row < glyph.length; row += 1) {
        const line = expectDefined(glyph[row], "treemap glyph row");
        for (let col = 0; col < line.length; col += 1) {
          if (line[col] !== "1") {
            continue;
          }
          this.rect(
            {
              x: cursorX + col * scale,
              y: cursorY + row * scale,
              width: scale,
              height: scale,
            },
            color,
          );
        }
      }
      cursorX += 6 * scale;
    }
  }
}

function inset(rect: Rect, padding: number): Rect {
  return {
    x: rect.x + padding,
    y: rect.y + padding,
    width: Math.max(0, rect.width - padding * 2),
    height: Math.max(0, rect.height - padding * 2),
  };
}

function drawLabel(
  canvas: PngCanvas,
  rect: Rect,
  lines: string[],
  color: Rgb,
  scale: number,
): void {
  const charWidth = 6 * scale;
  const lineHeight = 9 * scale;
  const maxChars = Math.floor((rect.width - 12) / charWidth);
  const maxLines = Math.floor((rect.height - 12) / lineHeight);
  if (maxChars < 4 || maxLines < 1) {
    return;
  }
  lines.slice(0, maxLines).forEach((line, index) => {
    const label = sanitizeLabel(line);
    canvas.text(
      rect.x + 7,
      rect.y + 7 + index * lineHeight,
      label.length > maxChars ? label.slice(0, maxChars - 1) : label,
      color,
      scale,
    );
  });
}

function buildGroups(
  report: SessionSystemPromptReport,
  conversation: TreemapLeaf[],
): TreemapGroup[] {
  const injectedTotal = report.injectedWorkspaceFiles.reduce(
    (sum, file) => (file.injectionStatus === "native_unverified" ? sum : sum + file.injectedChars),
    0,
  );
  const projectFrameChars = Math.max(0, report.systemPrompt.projectContextChars - injectedTotal);
  const skillTotal = report.skills.entries.reduce((sum, skill) => sum + skill.blockChars, 0);
  const systemBaseChars = Math.max(0, report.systemPrompt.nonProjectContextChars - skillTotal);
  const tools = report.tools.entries
    .map((tool) => ({ name: tool.name, value: tool.schemaChars ?? 0 }))
    .filter((tool) => tool.value > 0);
  const groups = [
    {
      name: "Conversation",
      color: rgb(201, 82, 96),
      leaves: conversation,
    },
    {
      name: "Workspace files",
      color: rgb(58, 145, 91),
      leaves: [
        ...report.injectedWorkspaceFiles
          .filter((file) => file.injectionStatus !== "native_unverified")
          .map((file) => ({
            name: file.name,
            value: file.injectedChars,
          })),
        { name: "Project context frame", value: projectFrameChars },
      ],
    },
    {
      name: "System prompt",
      color: rgb(222, 138, 46),
      leaves: [{ name: "Base instructions", value: systemBaseChars }],
    },
    {
      name: "Tool schemas",
      color: rgb(59, 118, 184),
      leaves: tools,
    },
    {
      name: "Skills",
      color: rgb(132, 91, 173),
      leaves: report.skills.entries.map((skill) => ({
        name: skill.name,
        value: skill.blockChars,
      })),
    },
  ];
  return groups
    .map((group) => Object.assign(group, { value: totalValue(group.leaves) }))
    .filter((group) => group.value > 0);
}

function drawTreemap(canvas: PngCanvas, groups: TreemapGroup[], rect: Rect): void {
  const groupRects = layoutBinary(groups, rect);
  groupRects.forEach(({ item: group, rect: groupRect }, groupIndex) => {
    const groupFill = mixColor(group.color, rgb(18, 22, 27), 0.16);
    canvas.rect(groupRect, groupFill);
    canvas.stroke(groupRect, rgb(14, 18, 22), 3);
    drawLabel(
      canvas,
      { x: groupRect.x + 4, y: groupRect.y + 4, width: groupRect.width - 8, height: 38 },
      [group.name, formatSize(group.value)],
      rgb(248, 250, 252),
      groupRect.width > 260 && groupRect.height > 120 ? 2 : 1,
    );
    const childRect = inset(
      {
        x: groupRect.x + TREEMAP_GAP,
        y: groupRect.y + (groupRect.height > 92 ? 44 : TREEMAP_GAP),
        width: groupRect.width - TREEMAP_GAP * 2,
        height: groupRect.height - (groupRect.height > 92 ? 48 : TREEMAP_GAP * 2),
      },
      0,
    );
    const leafRects = layoutBinary(group.leaves, childRect);
    leafRects.forEach(({ item: leaf, rect: leafRect }, leafIndex) => {
      const shade = (leafIndex % 7) / 10 + (groupIndex % 2) * 0.08;
      const fill = mixColor(group.color, rgb(255, 255, 255), shade);
      const inner = inset(leafRect, 1.5);
      canvas.rect(inner, fill);
      canvas.stroke(inner, rgb(8, 12, 16), 1);
      if (inner.width * inner.height > 5200) {
        const textColor =
          fill.r * 0.299 + fill.g * 0.587 + fill.b * 0.114 > 150
            ? rgb(16, 23, 31)
            : rgb(248, 250, 252);
        drawLabel(canvas, inner, [leaf.name, formatSize(leaf.value)], textColor, 1);
      }
    });
  });
}

function drawLegend(canvas: PngCanvas, groups: TreemapGroup[], rect: Rect, total: number): void {
  canvas.rect(rect, rgb(245, 247, 250));
  canvas.stroke(rect, rgb(213, 220, 228), 1);
  canvas.text(rect.x + 18, rect.y + 18, "LEGEND", rgb(30, 41, 59), 2);
  let y = rect.y + 58;
  groups.forEach((group) => {
    canvas.rect({ x: rect.x + 18, y, width: 18, height: 18 }, group.color);
    canvas.stroke({ x: rect.x + 18, y, width: 18, height: 18 }, rgb(15, 23, 42), 1);
    const pct = total > 0 ? `${Math.round((group.value / total) * 100)} PCT` : "0 PCT";
    drawLabel(
      canvas,
      { x: rect.x + 46, y: y - 1, width: rect.width - 62, height: 38 },
      [group.name, pct],
      rgb(30, 41, 59),
      1,
    );
    y += 54;
  });
}

export async function renderContextTreemapPng(params: {
  report: SessionSystemPromptReport;
  session: ContextTreemapSessionStats;
  conversation: TreemapLeaf[];
}): Promise<{ path: string; trackedChars: number; caption: string }> {
  const groups = buildGroups(params.report, params.conversation);
  const conversationChars = totalValue(params.conversation);
  const trackedChars = totalValue(groups);
  const canvas = new PngCanvas();
  canvas.rect({ x: 0, y: 0, width: WIDTH, height: HEIGHT }, rgb(238, 241, 245));
  canvas.rect({ x: 0, y: 0, width: WIDTH, height: HEADER_HEIGHT }, rgb(20, 26, 34));
  canvas.text(PADDING, 24, "CONTEXT TREEMAP", rgb(248, 250, 252), 3);
  const sourceLine = `${params.report.source.toUpperCase()} / ${params.report.provider ?? "provider"} / ${params.report.model ?? "model"}`;
  canvas.text(PADDING, 58, sanitizeLabel(sourceLine), rgb(176, 196, 222), 1);
  const treemapRect = {
    x: PADDING,
    y: HEADER_HEIGHT + PADDING,
    width: WIDTH - LEGEND_WIDTH - PADDING * 3,
    height: HEIGHT - HEADER_HEIGHT - FOOTER_HEIGHT - PADDING * 2,
  };
  drawTreemap(canvas, groups, treemapRect);
  drawLegend(
    canvas,
    groups,
    {
      x: WIDTH - LEGEND_WIDTH - PADDING,
      y: HEADER_HEIGHT + PADDING,
      width: LEGEND_WIDTH,
      height: treemapRect.height,
    },
    trackedChars,
  );
  const footerY = HEIGHT - FOOTER_HEIGHT + 18;
  const actual =
    params.session.cachedContextTokens == null
      ? "ACTUAL CTX UNKNOWN"
      : `ACTUAL CTX ${formatInt(params.session.cachedContextTokens)} TOK`;
  const window =
    params.session.contextWindowTokens == null || params.session.contextWindowTokens <= 0
      ? "WINDOW UNKNOWN"
      : `WINDOW ${formatInt(params.session.contextWindowTokens)} TOK`;
  canvas.text(
    PADDING,
    footerY,
    `${formatSize(trackedChars)} / ${actual} / ${window}`,
    rgb(51, 65, 85),
    1,
  );
  const outPath = path.join(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-context-map-${crypto.randomUUID()}.png`,
  );
  await writeFile(outPath, encodePngRgba(canvas.data, WIDTH, HEIGHT));
  const caption = [
    "Context treemap",
    `Source: ${params.report.source}`,
    `Tracked: ${formatInt(trackedChars)} chars (~${formatInt(estimateTokensFromChars(trackedChars))} tok)`,
    `Conversation: ${formatInt(conversationChars)} chars (~${formatInt(estimateTokensFromChars(conversationChars))} tok)`,
    params.session.cachedContextTokens == null
      ? "Actual cached context: unavailable"
      : `Actual cached context: ${formatInt(params.session.cachedContextTokens)} tok`,
  ].join("\n");
  return { path: outPath, trackedChars, caption };
}
