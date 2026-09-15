import { formatErrorMessage } from "../errors.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";

// A rejected shared handoff applies to every unsent payload, unlike a
// provider's permanent rejection of one payload. Keep this distinction internal.
export class OutboundHandoffRejectedError extends PlatformMessageNotDispatchedError {
  constructor(cause: unknown) {
    super(formatErrorMessage(cause), { cause, retryable: false });
  }
}

/** Call only while the current preparation or handoff is proven not dispatched. */
export function assertOutboundHandoffCurrent(assertCurrent: (() => void) | undefined): void {
  try {
    assertCurrent?.();
  } catch (error) {
    throw new OutboundHandoffRejectedError(error);
  }
}
