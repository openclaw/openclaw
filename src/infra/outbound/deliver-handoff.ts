import { formatErrorMessage } from "../errors.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";

// A rejected shared handoff applies to every unsent payload, unlike a
// provider's permanent rejection of one payload. Keep this distinction internal.
export class OutboundHandoffRejectedError extends PlatformMessageNotDispatchedError {
  constructor(cause: unknown) {
    super(formatErrorMessage(cause), { cause, retryable: false });
  }
}

/** Finds an exact rejected host handoff through delivery wrappers. */
export function findOutboundHandoffRejectedError(
  error: unknown,
): OutboundHandoffRejectedError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    if (current instanceof OutboundHandoffRejectedError) {
      return current;
    }
    seen.add(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

/** Call only while the current preparation or handoff is proven not dispatched. */
export function assertOutboundHandoffCurrent(assertCurrent: (() => void) | undefined): void {
  try {
    assertCurrent?.();
  } catch (error) {
    throw new OutboundHandoffRejectedError(error);
  }
}
