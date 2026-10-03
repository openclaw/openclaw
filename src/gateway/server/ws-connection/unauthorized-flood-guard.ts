import { ErrorCodes, type ErrorShape } from "../../../../packages/gateway-protocol/src/index.js";

/** Decision returned after recording one unauthorized role failure. */
type UnauthorizedFloodDecision = {
  shouldClose: boolean;
  shouldLog: boolean;
  count: number;
  suppressedSinceLastLog: number;
};

const CLOSE_AFTER = 10;

/** Counts unauthorized failures and decides when to log or close the socket. */
export class UnauthorizedFloodGuard {
  private count = 0;

  registerUnauthorized(): UnauthorizedFloodDecision {
    this.count += 1;
    const shouldClose = this.count > CLOSE_AFTER;
    return {
      shouldClose,
      shouldLog: this.count === 1 || shouldClose,
      count: this.count,
      suppressedSinceLastLog: this.count === CLOSE_AFTER + 1 ? CLOSE_AFTER - 1 : 0,
    };
  }

  reset(): void {
    this.count = 0;
  }
}

/** Identifies role-auth failures that should feed the flood guard. */
export function isUnauthorizedRoleError(error?: ErrorShape): boolean {
  if (!error) {
    return false;
  }
  return (
    error.code === ErrorCodes.INVALID_REQUEST &&
    typeof error.message === "string" &&
    error.message.startsWith("unauthorized role:")
  );
}
