import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

/** Maximum UTF-16 code units retained for one captured diagnostic content field. */
export const MAX_DIAGNOSTIC_CONTENT_CHARS = 128 * 1024;

export function truncateDiagnosticContent(value: string): string {
  return truncateUtf16Safe(value, MAX_DIAGNOSTIC_CONTENT_CHARS);
}

export function joinDiagnosticContent(
  parts: readonly string[],
  truncationSuffix = "",
): string | undefined {
  const contentBudget = MAX_DIAGNOSTIC_CONTENT_CHARS - truncationSuffix.length;
  let content = "";
  let truncated = false;
  for (const part of parts) {
    if (!part) {
      continue;
    }
    const separator = content ? "\n" : "";
    const remaining = contentBudget - content.length - separator.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const capturedPart = truncateUtf16Safe(part, remaining);
    if (!capturedPart) {
      truncated = true;
      break;
    }
    content += separator + capturedPart;
    if (capturedPart.length < part.length) {
      truncated = true;
      break;
    }
  }
  return content ? `${content}${truncated ? truncationSuffix : ""}` : undefined;
}
