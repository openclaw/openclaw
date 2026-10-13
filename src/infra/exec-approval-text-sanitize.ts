import { expectDefined } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Leaf sanitizer for approval display text; keep free of exec-approvals imports
// so approval-scope and exec-approvals-config can share it without a cycle.
import {
  computeSensitiveRedactionBitmap,
  redactSensitiveText,
  resolveRedactOptions,
} from "../logging/redact.js";

// Escape spoofing characters while preserving ASCII spaces and valid astral code points;
// Unicode mode makes Cs match only unpaired surrogate units.
const EXEC_APPROVAL_INVISIBLE_CHAR_REGEX =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0]/gu;
const EXEC_APPROVAL_INVISIBLE_CHAR_SINGLE =
  /^[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0]$/u;

// Bound regex work before redaction; truncate output afterward to avoid exposing partial secrets.
const EXEC_APPROVAL_MAX_INPUT = 256 * 1024;
const EXEC_APPROVAL_MAX_OUTPUT = 16 * 1024;
const EXEC_APPROVAL_TRUNCATION_MARKER = "…[truncated]";
const EXEC_APPROVAL_OVERSIZED_MARKER =
  "[exec approval command exceeds display size limit; full text suppressed]";
const EXEC_APPROVAL_WARNING_OVERSIZED_MARKER =
  "[exec approval warning exceeds display size limit; full text suppressed]";

const BYPASS_MASK = "***";

function formatCodePointEscape(char: string): string {
  return `\\u{${char.codePointAt(0)?.toString(16).toUpperCase() ?? "FFFD"}}`;
}

function normalizeDisplayLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n");
}

function escapeInvisibles(text: string, options?: { preserveLineBreaks?: boolean }): string {
  return text.replace(EXEC_APPROVAL_INVISIBLE_CHAR_REGEX, (char) =>
    options?.preserveLineBreaks && char === "\n" ? "\n" : formatCodePointEscape(char),
  );
}

/** Sanitized approval text plus size-cap status for callers that need UI affordances. */
export type SanitizedExecApprovalDisplayText = {
  /** Redacted, spoof-resistant command or warning text safe for an approval prompt. */
  text: string;
  /** True when sanitized output exceeded the display cap and was shortened. */
  truncated: boolean;
  /** True when raw input exceeded the hard cap and was replaced with a fixed marker. */
  oversized: boolean;
};

function truncateForDisplay(text: string): SanitizedExecApprovalDisplayText {
  if (text.length <= EXEC_APPROVAL_MAX_OUTPUT) {
    return { text, truncated: false, oversized: false };
  }
  return {
    text: truncateUtf16Safe(text, EXEC_APPROVAL_MAX_OUTPUT) + EXEC_APPROVAL_TRUNCATION_MARKER,
    truncated: true,
    oversized: false,
  };
}

// Iterate by code point so astral invisibles match Cf, then map back to UTF-16 offsets.
function buildStrippedView(original: string): { stripped: string; strippedToOrig: number[] } {
  const strippedChars: string[] = [];
  const strippedToOrig: number[] = [];
  let offset = 0;
  for (const cp of original) {
    if (!EXEC_APPROVAL_INVISIBLE_CHAR_SINGLE.test(cp)) {
      strippedChars.push(cp);
      for (let k = 0; k < cp.length; k++) {
        strippedToOrig.push(offset + k);
      }
    }
    offset += cp.length;
  }
  return { stripped: strippedChars.join(""), strippedToOrig };
}

function sanitizeExecApprovalDisplayTextInternal(
  commandText: string,
  options?: { preserveLineBreaks?: boolean; oversizedMarker?: string },
): SanitizedExecApprovalDisplayText {
  if (commandText.length > EXEC_APPROVAL_MAX_INPUT) {
    return {
      text: options?.oversizedMarker ?? EXEC_APPROVAL_OVERSIZED_MARKER,
      truncated: false,
      oversized: true,
    };
  }
  const rawRedacted = redactSensitiveText(commandText, { mode: "tools" });
  // With no invisibles the two views have identical redaction coverage.
  if (commandText.search(EXEC_APPROVAL_INVISIBLE_CHAR_REGEX) === -1) {
    return truncateForDisplay(escapeInvisibles(rawRedacted, options));
  }
  const { stripped, strippedToOrig } = buildStrippedView(commandText);
  const strippedRedacted = redactSensitiveText(stripped, { mode: "tools" });
  // Stripping invisibles exposed no extra secrets; retain the raw layout with visible escapes.
  if (strippedRedacted === stripped) {
    return truncateForDisplay(escapeInvisibles(rawRedacted, options));
  }
  // Compare coverage at original offsets: different rendering (such as a multiline PEM)
  // is not a bypass unless stripping invisibles exposes positions the raw view missed.
  const redaction = resolveRedactOptions({ mode: "tools" });
  const rawMask = computeSensitiveRedactionBitmap(commandText, redaction);
  const strippedMask = computeSensitiveRedactionBitmap(stripped, redaction);
  let bypassDetected = false;
  const unionMask = rawMask.slice();
  for (let i = 0; i < strippedMask.length; i++) {
    if (strippedMask[i]) {
      const originalIndex = expectDefined(strippedToOrig[i], "stripped to orig entry at i");
      bypassDetected ||= !rawMask[originalIndex];
      unionMask[originalIndex] = true;
    }
  }
  if (!bypassDetected) {
    return truncateForDisplay(escapeInvisibles(rawRedacted, options));
  }
  // Collapse the combined mask's runs and escape unmasked invisibles by code point.
  let out = "";
  let i = 0;
  while (i < commandText.length) {
    if (unionMask[i]) {
      let j = i;
      while (j < commandText.length && unionMask[j]) {
        j++;
      }
      out += BYPASS_MASK;
      i = j;
      continue;
    }
    const codePoint = commandText.codePointAt(i) ?? 0xfffd;
    const cp = String.fromCodePoint(codePoint);
    out +=
      options?.preserveLineBreaks && cp === "\n"
        ? cp
        : EXEC_APPROVAL_INVISIBLE_CHAR_SINGLE.test(cp)
          ? formatCodePointEscape(cp)
          : cp;
    i += cp.length;
  }
  return truncateForDisplay(out);
}

/** Sanitizes exec command text for approval UI without exposing status metadata. */
export function sanitizeExecApprovalDisplayText(commandText: string): string {
  return sanitizeExecApprovalDisplayTextInternal(commandText).text;
}

/**
 * Sanitizes exec command text for approval UI and reports whether size caps changed it.
 */
export function sanitizeExecApprovalDisplayTextWithStatus(
  commandText: string,
): SanitizedExecApprovalDisplayText {
  return sanitizeExecApprovalDisplayTextInternal(commandText);
}

/**
 * Sanitizes warning prose for approval UI while preserving real line boundaries.
 */
export function sanitizeExecApprovalWarningText(warningText: string): string {
  return sanitizeExecApprovalWarningTextWithStatus(warningText).text;
}

/** Sanitizes warning prose and reports whether display bounds suppressed any content. */
export function sanitizeExecApprovalWarningTextWithStatus(
  warningText: string,
): SanitizedExecApprovalDisplayText {
  return sanitizeExecApprovalDisplayTextInternal(normalizeDisplayLineBreaks(warningText), {
    preserveLineBreaks: true,
    oversizedMarker: EXEC_APPROVAL_WARNING_OVERSIZED_MARKER,
  });
}

/** Checks the existing approval code-point cap without materializing every character. */
export function exceedsApprovalTextLimit(value: string, maxLength: number): boolean {
  // A code point occupies one or two UTF-16 units. Bounds settle ordinary short
  // values immediately; the remaining scan stops as soon as rejection is certain.
  if (value.length <= maxLength) {
    return false;
  }
  if (value.length > maxLength * 2) {
    return true;
  }
  let remaining = maxLength;
  for (const _ of value) {
    if (--remaining < 0) {
      return true;
    }
  }
  return false;
}
