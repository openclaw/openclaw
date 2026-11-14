import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";

export function readMessageIdempotencyKey(message: unknown): string | null {
  return normalizeNullableString(asOptionalRecord(message)?.idempotencyKey);
}

/**
 * A command mirror that stays in the transcript without becoming the current user turn.
 * Context-free commands are excluded from model context. A fast-abort exchange remains
 * stored history, but neither one supersedes a user turn that was already persisted.
 */
export function isInFlightTurnTransparentMessage(message: unknown): boolean {
  const record = asOptionalRecord(message);
  if (!record) {
    return false;
  }
  const metadata = asOptionalRecord(record["__openclaw"]);
  return (
    (record.excludeFromContext === true && metadata?.contextFreeCommand === true) ||
    metadata?.preservesInFlightTurn === true
  );
}
