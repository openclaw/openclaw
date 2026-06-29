/**
 * Wrap RTL-script lines in Unicode bidirectional isolate controls (FSI-style)
 * so trailing LTR punctuation (".", "?", "!", parentheses, etc.) renders on
 * the visually-correct side of the line on Discord, Slack, Telegram,
 * WhatsApp, terminals, and any other surface that honors the bidi algorithm.
 *
 * Extracted from the TUI renderer so the same isolation can be applied to
 * the canonical outbound assistant-visible text sanitizer (#68105). The
 * line-level guard against existing bidi control characters keeps the
 * function idempotent: re-wrapping already-isolated text is a no-op.
 */

import { findCodeRegions, isInsideCode, type CodeRegion } from "./code-regions.js";

const RTL_SCRIPT_RE = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
const BIDI_CONTROL_RE = /[\u202a-\u202e\u2066-\u2069]/;
const RTL_ISOLATE_START = "\u2067";
const RTL_ISOLATE_END = "\u2069";

function hasRtlScriptOutsideCode(
  line: string,
  lineStart: number,
  codeRegions: CodeRegion[],
): boolean {
  if (!RTL_SCRIPT_RE.test(line)) {
    return false;
  }
  for (let idx = 0; idx < line.length; idx += 1) {
    if (RTL_SCRIPT_RE.test(line[idx] ?? "") && !isInsideCode(lineStart + idx, codeRegions)) {
      return true;
    }
  }
  return false;
}

function isolateRtlLine(line: string, lineStart: number, codeRegions: CodeRegion[]): string {
  if (!hasRtlScriptOutsideCode(line, lineStart, codeRegions) || BIDI_CONTROL_RE.test(line)) {
    return line;
  }
  return `${RTL_ISOLATE_START}${line}${RTL_ISOLATE_END}`;
}

export function applyRtlIsolation(text: string): string {
  if (!RTL_SCRIPT_RE.test(text)) {
    return text;
  }
  const codeRegions = findCodeRegions(text);
  const lines: string[] = [];
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newlineIndex = text.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
    lines.push(isolateRtlLine(text.slice(lineStart, lineEnd), lineStart, codeRegions));
    if (newlineIndex === -1) {
      break;
    }
    lineStart = newlineIndex + 1;
  }
  return lines.join("\n");
}

export const RTL_ISOLATION_REGEX = {
  rtlScript: RTL_SCRIPT_RE,
  bidiControl: BIDI_CONTROL_RE,
} as const;

export const RTL_ISOLATION_MARKERS = {
  start: RTL_ISOLATE_START,
  end: RTL_ISOLATE_END,
} as const;
