import type { MarkdownTableMode } from "../config/types.base.js";
import {
  chunkMarkdownIR,
  markdownToIR,
  type MarkdownIR,
  type MarkdownStyle,
} from "../markdown/ir.js";

type SignalTextStyle = "BOLD" | "ITALIC" | "STRIKETHROUGH" | "MONOSPACE" | "SPOILER";

export type SignalTextStyleRange = {
  start: number;
  length: number;
  style: SignalTextStyle;
};

export type SignalFormattedText = {
  text: string;
  styles: SignalTextStyleRange[];
};

type SignalMarkdownOptions = {
  tableMode?: MarkdownTableMode;
};

type SignalStyleSpan = {
  start: number;
  end: number;
  style: SignalTextStyle;
};

type Insertion = {
  pos: number;
  length: number;
};

function normalizeUrlForComparison(url: string): string {
  let normalized = url.toLowerCase();
  // Strip protocol
  normalized = normalized.replace(/^https?:\/\//, "");
  // Strip www. prefix
  normalized = normalized.replace(/^www\./, "");
  // Strip trailing slashes
  normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

function mapStyle(style: MarkdownStyle): SignalTextStyle | null {
  switch (style) {
    case "bold":
      return "BOLD";
    case "italic":
      return "ITALIC";
    case "strikethrough":
      return "STRIKETHROUGH";
    case "code":
    case "code_block":
      return "MONOSPACE";
    case "spoiler":
      return "SPOILER";
    default:
      return null;
  }
}

function mergeStyles(styles: SignalTextStyleRange[]): SignalTextStyleRange[] {
  const sorted = [...styles].toSorted((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    if (a.length !== b.length) {
      return a.length - b.length;
    }
    return a.style.localeCompare(b.style);
  });

  const merged: SignalTextStyleRange[] = [];
  for (const style of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.style === style.style && style.start <= prev.start + prev.length) {
      const prevEnd = prev.start + prev.length;
      const nextEnd = Math.max(prevEnd, style.start + style.length);
      prev.length = nextEnd - prev.start;
      continue;
    }
    merged.push({ ...style });
  }

  return merged;
}

function clampStyles(styles: SignalTextStyleRange[], maxLength: number): SignalTextStyleRange[] {
  const clamped: SignalTextStyleRange[] = [];
  for (const style of styles) {
    const start = Math.max(0, Math.min(style.start, maxLength));
    const end = Math.min(style.start + style.length, maxLength);
    const length = end - start;
    if (length > 0) {
      clamped.push({ start, length, style: style.style });
    }
  }
  return clamped;
}

function applyInsertionsToStyles(
  spans: SignalStyleSpan[],
  insertions: Insertion[],
): SignalStyleSpan[] {
  if (insertions.length === 0) {
    return spans;
  }
  const sortedInsertions = [...insertions].toSorted((a, b) => a.pos - b.pos);
  let updated = spans;
  let cumulativeShift = 0;

  for (const insertion of sortedInsertions) {
    const insertionPos = insertion.pos + cumulativeShift;
    const next: SignalStyleSpan[] = [];
    for (const span of updated) {
      if (span.end <= insertionPos) {
        next.push(span);
        continue;
      }
      if (span.start >= insertionPos) {
        next.push({
          start: span.start + insertion.length,
          end: span.end + insertion.length,
          style: span.style,
        });
        continue;
      }
      if (span.start < insertionPos && span.end > insertionPos) {
        if (insertionPos > span.start) {
          next.push({
            start: span.start,
            end: insertionPos,
            style: span.style,
          });
        }
        const shiftedStart = insertionPos + insertion.length;
        const shiftedEnd = span.end + insertion.length;
        if (shiftedEnd > shiftedStart) {
          next.push({
            start: shiftedStart,
            end: shiftedEnd,
            style: span.style,
          });
        }
      }
    }
    updated = next;
    cumulativeShift += insertion.length;
  }

  return updated;
}

function renderSignalText(ir: MarkdownIR): SignalFormattedText {
  const text = ir.text ?? "";
  if (!text) {
    return { text: "", styles: [] };
  }

  const sortedLinks = [...ir.links].toSorted((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  const insertions: Insertion[] = [];

  for (const link of sortedLinks) {
    if (link.start < cursor) {
      continue;
    }
    out += text.slice(cursor, link.end);

    const href = link.href.trim();
    const label = text.slice(link.start, link.end);
    const trimmedLabel = label.trim();

    if (href) {
      if (!trimmedLabel) {
        out += href;
        insertions.push({ pos: link.end, length: href.length });
      } else {
        // Check if label is similar enough to URL that showing both would be redundant
        const normalizedLabel = normalizeUrlForComparison(trimmedLabel);
        let comparableHref = href;
        if (href.startsWith("mailto:")) {
          comparableHref = href.slice("mailto:".length);
        }
        const normalizedHref = normalizeUrlForComparison(comparableHref);

        // Only show URL if label is meaningfully different from it
        if (normalizedLabel !== normalizedHref) {
          const addition = ` (${href})`;
          out += addition;
          insertions.push({ pos: link.end, length: addition.length });
        }
      }
    }

    cursor = link.end;
  }

  out += text.slice(cursor);

  const mappedStyles: SignalStyleSpan[] = ir.styles
    .map((span) => {
      const mapped = mapStyle(span.style);
      if (!mapped) {
        return null;
      }
      return { start: span.start, end: span.end, style: mapped };
    })
    .filter((span): span is SignalStyleSpan => span !== null);

  const adjusted = applyInsertionsToStyles(mappedStyles, insertions);
  const trimmedText = out.trimEnd();
  const trimmedLength = trimmedText.length;
  const clamped = clampStyles(
    adjusted.map((span) => ({
      start: span.start,
      length: span.end - span.start,
      style: span.style,
    })),
    trimmedLength,
  );

  return {
    text: trimmedText,
    styles: mergeStyles(clamped),
  };
}

export function markdownToSignalText(
  markdown: string,
  options: SignalMarkdownOptions = {},
): SignalFormattedText {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    enableSpoilers: true,
    headingStyle: "bold",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
  return renderSignalText(ir);
}

function sliceSignalStyles(
  styles: SignalTextStyleRange[],
  start: number,
  end: number,
): SignalTextStyleRange[] {
  const sliced: SignalTextStyleRange[] = [];
  for (const style of styles) {
    const styleEnd = style.start + style.length;
    const sliceStart = Math.max(style.start, start);
    const sliceEnd = Math.min(styleEnd, end);
    if (sliceEnd > sliceStart) {
      sliced.push({
        start: sliceStart - start,
        length: sliceEnd - sliceStart,
        style: style.style,
      });
    }
  }
  return sliced;
}

/**
 * Split Signal formatted text into chunks under the limit while preserving styles.
 *
 * This implementation deterministically tracks cursor position without using indexOf,
 * which is fragile when chunks are trimmed or when duplicate substrings exist.
 * Styles spanning chunk boundaries are split into separate ranges for each chunk.
 */
function splitSignalFormattedText(
  formatted: SignalFormattedText,
  limit: number,
): SignalFormattedText[] {
  const { text, styles } = formatted;

  if (text.length <= limit) {
    return [formatted];
  }

  const results: SignalFormattedText[] = [];
  let remaining = text;
  let offset = 0; // Track position in original text for style slicing

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      // Last chunk - take everything remaining
      const trimmed = remaining.trimEnd();
      if (trimmed.length > 0) {
        results.push({
          text: trimmed,
          styles: mergeStyles(sliceSignalStyles(styles, offset, offset + trimmed.length)),
        });
      }
      break;
    }

    // Find a good break point within the limit
    const window = remaining.slice(0, limit);
    let breakIdx = findBreakIndex(window);

    // If no good break point found, hard break at limit
    if (breakIdx <= 0) {
      breakIdx = limit;
    }

    // Extract chunk and trim trailing whitespace
    const rawChunk = remaining.slice(0, breakIdx);
    const chunk = rawChunk.trimEnd();

    if (chunk.length > 0) {
      results.push({
        text: chunk,
        styles: mergeStyles(sliceSignalStyles(styles, offset, offset + chunk.length)),
      });
    }

    // Advance past the chunk and any whitespace separator
    const brokeOnWhitespace = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
    const nextStart = Math.min(remaining.length, breakIdx + (brokeOnWhitespace ? 1 : 0));

    // Chunks are sent as separate messages, so we intentionally drop boundary whitespace.
    // Keep `offset` in sync with the dropped characters so style slicing stays correct.
    remaining = remaining.slice(nextStart).trimStart();
    offset = text.length - remaining.length;
  }

  return results;
}

/**
 * Find the best break index within a text window.
 * Prefers newlines over whitespace, avoids breaking inside parentheses.
 */
function findBreakIndex(window: string): number {
  let lastNewline = -1;
  let lastWhitespace = -1;
  let parenDepth = 0;

  for (let i = 0; i < window.length; i++) {
    const char = window[i];

    if (char === "(") {
      parenDepth++;
      continue;
    }
    if (char === ")" && parenDepth > 0) {
      parenDepth--;
      continue;
    }

    // Only consider break points outside parentheses
    if (parenDepth === 0) {
      if (char === "\n") {
        lastNewline = i;
      } else if (/\s/.test(char)) {
        lastWhitespace = i;
      }
    }
  }

  // Prefer newline break, fall back to whitespace
  return lastNewline > 0 ? lastNewline : lastWhitespace;
}

export function markdownToSignalTextChunks(
  markdown: string,
  limit: number,
  options: SignalMarkdownOptions = {},
): SignalFormattedText[] {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    enableSpoilers: true,
    headingStyle: "bold",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
  const chunks = chunkMarkdownIR(ir, limit);
  const results: SignalFormattedText[] = [];

  for (const chunk of chunks) {
    const rendered = renderSignalText(chunk);
    // If link expansion caused the chunk to exceed the limit, re-chunk it
    if (rendered.text.length > limit) {
      results.push(...splitSignalFormattedText(rendered, limit));
    } else {
      results.push(rendered);
    }
  }

  return results;
}
