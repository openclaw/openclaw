import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";

export class SessionMutationAuthorizationChangedError extends Error {
  readonly error: ErrorShape;

  constructor(error: ErrorShape) {
    super(error.message);
    this.name = "SessionMutationAuthorizationChangedError";
    this.error = error;
  }
}

/** A bounded retry hint only, never evidence of permission to use a session. */
export function isSessionAccessRefreshingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "SessionMutationAuthorizationChangedError" &&
    "error" in error &&
    isRecord(error.error) &&
    error.error.code === "UNAVAILABLE" &&
    error.error.retryable === true &&
    isRecord(error.error.details) &&
    error.error.details.code === "SESSION_ACCESS_REFRESHING"
  );
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
