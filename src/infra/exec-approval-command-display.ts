import { redactSensitiveText } from "../logging/redact.js";
import type { ExecApprovalRequestPayload } from "./exec-approvals.js";

// Escape invisible characters, control characters, and Unicode line/paragraph separators that
// can spoof approval prompts in common UIs.
const EXEC_APPROVAL_INVISIBLE_CHAR_REGEX =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0]/gu;

function formatCodePointEscape(char: string): string {
  return `\\u{${char.codePointAt(0)?.toString(16).toUpperCase() ?? "FFFD"}}`;
}

export function sanitizeExecApprovalDisplayText(commandText: string): string {
  // Attempt redaction first on the raw text to catch secrets that appear verbatim.
  const rawRedacted = redactSensitiveText(commandText, { mode: "tools" });
  // Also run redaction against a view with invisible/control/separator characters stripped, so an
  // attacker cannot defeat token regexes (e.g. `\b(sk-[A-Za-z0-9_-]{8,})\b`) by splicing a
  // zero-width or other invisible character into the middle of a secret. If the stripped-view
  // redaction masked something the raw-view redaction missed, fall back to the stripped-view
  // result: positional fidelity of the invisibles is sacrificed for keeping the secret out of
  // the approval display. Otherwise keep the raw-view result so the operator can still see
  // exactly where invisibles were injected.
  const stripped = commandText.replace(EXEC_APPROVAL_INVISIBLE_CHAR_REGEX, "");
  const strippedRedacted = redactSensitiveText(stripped, { mode: "tools" });
  const base = strippedRedacted === stripped ? rawRedacted : strippedRedacted;
  return base.replace(EXEC_APPROVAL_INVISIBLE_CHAR_REGEX, formatCodePointEscape);
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
