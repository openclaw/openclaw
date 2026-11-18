import type { ReplyOperation } from "./session-controller.contracts.js";
import {
  getSessionControllerEntryForOperation,
  isCurrentSessionControllerOperation,
} from "./session-controller.identity.js";

/** Binds a source only while the exact operation still owns its run slot. */
export function bindSessionControllerSourceTurnId(
  operation: ReplyOperation,
  sourceTurnId: string,
): void {
  // Durable admission can finish after reset has replaced this operation.
  if (
    !isCurrentSessionControllerOperation(operation) ||
    operation.result ||
    operation.abortSignal.aborted
  ) {
    return;
  }
  getSessionControllerEntryForOperation(operation).sourceTurnId = sourceTurnId;
}
