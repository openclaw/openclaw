import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { redactSensitiveText } from "../logging/redact.js";

/** Maximum UTF-16 code units retained for one captured diagnostic content field. */
const MAX_DIAGNOSTIC_CONTENT_CHARS = 128 * 1024;

export function truncateDiagnosticContent(value: string): string {
  // Redaction must run before bounding: truncating first can split a multi-line
  // secret block (e.g. a PEM key) so the redactor no longer recognizes it, leaking
  // the unredacted remainder to the collector.
  return truncateUtf16Safe(redactSensitiveText(value), MAX_DIAGNOSTIC_CONTENT_CHARS);
}

export function joinDiagnosticContent(
  parts: readonly string[],
  truncationSuffix = "",
): string | undefined {
  const contentBudget = MAX_DIAGNOSTIC_CONTENT_CHARS - truncationSuffix.length;
  // Redaction must see the complete logical content: streamed parts can split
  // a secret block (e.g. a PEM key) so per-part redaction would miss it, and
  // per-part length accounting would misread redaction shortening as
  // truncation and drop later answer parts.
  const redacted = redactSensitiveText(parts.filter((part) => part).join("\n"));
  if (!redacted) {
    return undefined;
  }
  if (redacted.length <= contentBudget) {
    return redacted;
  }
  return `${truncateUtf16Safe(redacted, contentBudget)}${truncationSuffix}`;
}
