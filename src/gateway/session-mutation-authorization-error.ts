import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/schema/error-codes.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";

export class SessionMutationAuthorizationChangedError extends Error {
  readonly error: ErrorShape;

  constructor(error: ErrorShape) {
    super(error.message);
    this.name = "SessionMutationAuthorizationChangedError";
    this.error = error;
  }
}

/** Callers retain their live policy checks; only the forbidden envelope is shared. */
export function sessionMutationForbiddenError(
  message: string,
): SessionMutationAuthorizationChangedError {
  return new SessionMutationAuthorizationChangedError(errorShape(ErrorCodes.FORBIDDEN, message));
}

export class SessionSharingProfileFactsChangedError extends SessionMutationAuthorizationChangedError {
  readonly readSource: () => OpenClawStateDatabaseOptions;

  constructor(error: ErrorShape, readSource: () => OpenClawStateDatabaseOptions) {
    super(error);
    this.readSource = readSource;
  }
}

export type SessionMutationTarget = {
  sessionKey: string;
  agentId?: string;
};
