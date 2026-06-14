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

const RTL_SCRIPT_RE = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
const BIDI_CONTROL_RE = /[\u202a-\u202e\u2066-\u2069]/;
const RTL_ISOLATE_START = "\u2067";
const RTL_ISOLATE_END = "\u2069";

function isolateRtlLine(line: string): string {
  if (!RTL_SCRIPT_RE.test(line) || BIDI_CONTROL_RE.test(line)) {
    return line;
  }
  return `${RTL_ISOLATE_START}${line}${RTL_ISOLATE_END}`;
}

export function applyRtlIsolation(text: string): string {
  if (!RTL_SCRIPT_RE.test(text)) {
    return text;
  }
  return text
    .split("\n")
    .map((line) => isolateRtlLine(line))
    .join("\n");
}

export const RTL_ISOLATION_REGEX = {
  rtlScript: RTL_SCRIPT_RE,
  bidiControl: BIDI_CONTROL_RE,
} as const;

export const RTL_ISOLATION_MARKERS = {
  start: RTL_ISOLATE_START,
  end: RTL_ISOLATE_END,
} as const;
