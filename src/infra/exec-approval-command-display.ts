import { redactSensitiveText, resolveRedactOptions } from "../logging/redact.js";
import type { ExecApprovalRequestPayload } from "./exec-approvals.js";

// Escape control characters, Unicode format/line/paragraph separators, and non-ASCII space
// separators that can spoof approval prompts in common UIs. Ordinary ASCII space (U+0020) is
// intentionally excluded so normal command text renders unchanged.
const EXEC_APPROVAL_INVISIBLE_CHAR_REGEX =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0]/gu;
const EXEC_APPROVAL_INVISIBLE_CHAR_SINGLE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0]/u;

// Upper bound on input size for display sanitization to avoid unbounded regex work on huge
// attacker-controlled command payloads. Commands longer than this are truncated for display
// only; execution decisions are made from the raw payload elsewhere.
const EXEC_APPROVAL_MAX_DISPLAY_INPUT = 16 * 1024;
const EXEC_APPROVAL_TRUNCATION_MARKER = "…[truncated]";

const BYPASS_MASK = "***";

function formatCodePointEscape(char: string): string {
  return `\\u{${char.codePointAt(0)?.toString(16).toUpperCase() ?? "FFFD"}}`;
}

function escapeInvisibles(text: string): string {
  return text.replace(EXEC_APPROVAL_INVISIBLE_CHAR_REGEX, formatCodePointEscape);
}

// Build a boolean bitmap of positions in `text` that ANY redaction pattern would match.
// Patterns are applied independently to the raw text (not sequentially against a
// progressively-redacted view) so later patterns can still find matches that the in-place
// redaction would have replaced first. That is conservative — it may over-count overlapping
// matches — but that is acceptable for a coverage check.
function computeRedactionBitmap(text: string, patterns: RegExp[]): boolean[] {
  const bitmap: boolean[] = Array.from({ length: text.length }, () => false);
  for (const pattern of patterns) {
    const iter = pattern.flags.includes("g")
      ? new RegExp(pattern.source, pattern.flags)
      : new RegExp(pattern.source, `${pattern.flags}g`);
    for (const match of text.matchAll(iter)) {
      if (match.index === undefined) {
        continue;
      }
      const end = match.index + match[0].length;
      for (let i = match.index; i < end; i++) {
        bitmap[i] = true;
      }
    }
  }
  return bitmap;
}

function buildStrippedView(original: string): { stripped: string; strippedToOrig: number[] } {
  const strippedChars: string[] = [];
  const strippedToOrig: number[] = [];
  for (let i = 0; i < original.length; i++) {
    const ch = original[i];
    if (EXEC_APPROVAL_INVISIBLE_CHAR_SINGLE.test(ch)) {
      continue;
    }
    strippedChars.push(ch);
    strippedToOrig.push(i);
  }
  return { stripped: strippedChars.join(""), strippedToOrig };
}

export function sanitizeExecApprovalDisplayText(commandText: string): string {
  // Truncate oversized input before any regex work to bound CPU/memory on attacker-controlled
  // payloads. The sanitizer runs the full token pattern set over the text multiple times, so
  // we cap the work at a constant multiple of a reasonable display size.
  const input =
    commandText.length > EXEC_APPROVAL_MAX_DISPLAY_INPUT
      ? commandText.slice(0, EXEC_APPROVAL_MAX_DISPLAY_INPUT) + EXEC_APPROVAL_TRUNCATION_MARKER
      : commandText;
  const rawRedacted = redactSensitiveText(input, { mode: "tools" });
  const { stripped, strippedToOrig } = buildStrippedView(input);
  const strippedRedacted = redactSensitiveText(stripped, { mode: "tools" });
  // Fast path: stripping invisibles did not expose any additional secret-like content, so the
  // raw-view redaction is sufficient. Preserve structure and show invisible-character spoof
  // attempts as `\u{...}` escapes.
  if (strippedRedacted === stripped) {
    return escapeInvisibles(rawRedacted);
  }
  // Detect bypass by position-bitmap coverage. Run each redaction pattern independently on
  // both views and map stripped-view match positions back to original coordinates. If every
  // position the stripped view would mask is also masked by the raw view, the raw view
  // already covered everything — for example, an ordinary multi-line PEM private key where
  // raw produces `BEGIN/…redacted…/END` while stripped collapses to `***`. A real bypass
  // exists only when the stripped view masks at least one original position raw missed (e.g.
  // the tail of an `sk-` token whose prefix-boundary was broken by a spliced zero-width or
  // NBSP character).
  const { patterns } = resolveRedactOptions({ mode: "tools" });
  const rawMask = computeRedactionBitmap(input, patterns);
  const strippedMask = computeRedactionBitmap(stripped, patterns);
  let bypassDetected = false;
  for (let i = 0; i < strippedMask.length; i++) {
    if (strippedMask[i] && !rawMask[strippedToOrig[i]]) {
      bypassDetected = true;
      break;
    }
  }
  if (!bypassDetected) {
    return escapeInvisibles(rawRedacted);
  }
  // Bypass path. Project the stripped-view mask back onto original positions, union with the
  // raw-view mask, and emit a rendering where each contiguous masked run becomes a single
  // `***` marker. Invisible characters that fall outside masked runs still render as visible
  // `\u{...}` escapes so multi-line structure and spliced invisibles stay readable.
  const unionMask = rawMask.slice();
  for (let i = 0; i < strippedMask.length; i++) {
    if (strippedMask[i]) {
      unionMask[strippedToOrig[i]] = true;
    }
  }
  let out = "";
  let i = 0;
  while (i < input.length) {
    if (unionMask[i]) {
      let j = i;
      while (j < input.length && unionMask[j]) {
        j++;
      }
      out += BYPASS_MASK;
      i = j;
      continue;
    }
    const ch = input[i];
    out += EXEC_APPROVAL_INVISIBLE_CHAR_SINGLE.test(ch) ? formatCodePointEscape(ch) : ch;
    i++;
  }
  return out;
}

function normalizePreview(commandText: string, commandPreview?: string | null): string | null {
  const previewRaw = commandPreview?.trim() ?? "";
  if (!previewRaw) {
    return null;
  }
  const preview = sanitizeExecApprovalDisplayText(previewRaw);
  if (preview === commandText) {
    return null;
  }
  return preview;
}

export function resolveExecApprovalCommandDisplay(request: ExecApprovalRequestPayload): {
  commandText: string;
  commandPreview: string | null;
} {
  const commandTextSource =
    request.command ||
    (request.host === "node" && request.systemRunPlan ? request.systemRunPlan.commandText : "");
  const commandText = sanitizeExecApprovalDisplayText(commandTextSource);
  const previewSource =
    request.commandPreview ??
    (request.host === "node" ? (request.systemRunPlan?.commandPreview ?? null) : null);
  return {
    commandText,
    commandPreview: normalizePreview(commandText, previewSource),
  };
}
