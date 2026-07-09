// Assistant identity helpers normalize assistant identity labels and metadata.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

/** Normalizes optional assistant identity fields and truncates them to the caller's limit. */
export function coerceIdentityValue(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return truncateUtf16Safe(trimmed, maxLength);
}
