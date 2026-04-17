import { redactSensitiveText } from "../logging/redact.js";
import type { ExecApprovalRequestPayload } from "./exec-approvals.js";

// Escape control characters, Unicode format/line/paragraph separators, and non-ASCII space
// separators that can spoof approval prompts in common UIs. Ordinary ASCII space (U+0020) is
// intentionally excluded so normal command text renders unchanged.
const EXEC_APPROVAL_INVISIBLE_CHAR_REGEX =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0]/gu;

// Stripping set for the redaction-bypass detection pass. Includes non-ASCII Unicode space
// separators so splicing an NBSP, narrow NBSP, ideographic space, etc. into a secret cannot
// defeat token regexes that rely on word boundaries. Ordinary ASCII space (U+0020) is kept so
// stripping does not destroy the word boundaries that those same token regexes rely on.
const EXEC_APPROVAL_BYPASS_STRIP_REGEX =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0]/gu;

function formatCodePointEscape(char: string): string {
  return `\\u{${char.codePointAt(0)?.toString(16).toUpperCase() ?? "FFFD"}}`;
}

function escapeInvisibles(text: string): string {
  return text.replace(EXEC_APPROVAL_INVISIBLE_CHAR_REGEX, formatCodePointEscape);
}

export function sanitizeExecApprovalDisplayText(commandText: string): string {
  // Redact against the raw text first so verbatim secrets are masked in place and the original
  // positions of invisible/control characters can still be shown to the operator as escape
  // markers.
  const rawRedacted = redactSensitiveText(commandText, { mode: "tools" });
  // Also redact against a view with invisible/control/non-ASCII space characters stripped so an
  // attacker cannot defeat token regexes (e.g. `\b(sk-[A-Za-z0-9_-]{8,})\b`) by splicing a
  // zero-width character, NBSP, or other Unicode space into the middle of a secret.
  const stripped = commandText.replace(EXEC_APPROVAL_BYPASS_STRIP_REGEX, "");
  const strippedRedacted = redactSensitiveText(stripped, { mode: "tools" });
  if (strippedRedacted === stripped) {
    // No additional match in the stripped view; render the raw-redaction with invisibles
    // escaped so the operator can still see multi-line boundaries and spliced invisibles.
    return escapeInvisibles(rawRedacted);
  }
  // Stripped view found at least one redaction. Compare against a raw-redaction view
  // normalized the same way; if the stripped view redacted MORE than raw did, that signals a
  // bypass attempt (a secret that only matches after invisibles are removed). Otherwise both
  // views caught the same secrets and the escape-preserving raw display is safe to use.
  const rawRedactedStripped = rawRedacted.replace(EXEC_APPROVAL_BYPASS_STRIP_REGEX, "");
  if (strippedRedacted.length >= rawRedactedStripped.length) {
    return escapeInvisibles(rawRedacted);
  }
  // Bypass detected: suppress the raw display (it would still show the portion of the secret
  // that survived word-boundary matching). Emit a marker that preserves line-count context so
  // the operator is not misled about multi-line boundaries, plus the stripped+redacted form.
  const lineCount = commandText.split(/\r\n|\r|\n|\u2028|\u2029/).length;
  const lineLabel =
    lineCount > 1
      ? `${lineCount}-line command with obfuscated sensitive content`
      : "command with obfuscated sensitive content";
  return `[${lineLabel}; redacted view: ${escapeInvisibles(strippedRedacted)}]`;
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
