import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";

export function readMessageIdempotencyKey(message: unknown): string | null {
  return normalizeNullableString(asOptionalRecord(message)?.idempotencyKey);
}
