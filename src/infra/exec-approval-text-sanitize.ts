import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Escape spoofing characters while preserving ASCII spaces and valid astral code points;
// Unicode mode makes Cs match only unpaired surrogate units.
const EXEC_APPROVAL_INVISIBLE_CHAR_REGEX =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0]/gu;
// Bound display work and output for oversized commands.
const EXEC_APPROVAL_MAX_INPUT = 256 * 1024;
const EXEC_APPROVAL_MAX_OUTPUT = 16 * 1024;
const EXEC_APPROVAL_TRUNCATION_MARKER = "…[truncated]";
const EXEC_APPROVAL_OVERSIZED_MARKER =
  "[exec approval command exceeds display size limit; full text suppressed]";
const EXEC_APPROVAL_WARNING_OVERSIZED_MARKER =
  "[exec approval warning exceeds display size limit; full text suppressed]";

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
  /** Spoof-resistant command or warning text for an approval prompt. */
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
  return truncateForDisplay(escapeInvisibles(commandText, options));
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
