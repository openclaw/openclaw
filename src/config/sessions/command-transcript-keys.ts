// Leaf contract for the idempotency keys a delivered command exchange writes.
// Kept import-free so both the writer and turn navigation can use it without a cycle.
export const COMMAND_INPUT_IDEMPOTENCY_PREFIX = "command-input:" as const;
export const COMMAND_REPLY_IDEMPOTENCY_PREFIX = "command-reply:" as const;

/** True for the user/assistant rows a delivered command exchange writes. */
export function isCommandExchangeIdempotencyKey(key: unknown): boolean {
  return (
    typeof key === "string" &&
    (key.startsWith(COMMAND_INPUT_IDEMPOTENCY_PREFIX) ||
      key.startsWith(COMMAND_REPLY_IDEMPOTENCY_PREFIX))
  );
}
