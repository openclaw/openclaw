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
