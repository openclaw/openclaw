// Composes the operator-facing "run aborted" notice, bounding the untrusted
// abort diagnostic to one sanitized line before it reaches the chat log.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeRenderableText } from "./tui-formatters.js";

const MAX_ABORT_DIAGNOSTIC_LENGTH = 160;

export function formatRunAbortedNotice(errorMessage: string | undefined): string {
  const diagnostic = sanitizeRenderableText(errorMessage ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!diagnostic) {
    return "run aborted";
  }
  const bounded =
    diagnostic.length > MAX_ABORT_DIAGNOSTIC_LENGTH
      ? `${truncateUtf16Safe(diagnostic, MAX_ABORT_DIAGNOSTIC_LENGTH - 1)}…`
      : diagnostic;
  return `run aborted: ${bounded}`;
}
