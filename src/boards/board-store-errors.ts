import { collectErrorGraphCandidates, extractErrorCode, readErrorName } from "../infra/errors.js";
import { isSqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { BoardValidationError } from "./board-layout.js";

export function restoreBoardError(error: unknown): unknown {
  if (
    error instanceof Error &&
    error.name === "BoardValidationError" &&
    "code" in error &&
    (error.code === "conflict" || error.code === "invalid_operation" || error.code === "not_found")
  ) {
    return new BoardValidationError(error.code, error.message);
  }
  return error;
}

/** Invalidation never grants retries; transported post-execution failures are plain Errors. */
export function hasUnknownBoardWriteOutcome(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (current) =>
    current instanceof AggregateError ? [current.cause] : [],
  ).some(
    (current) =>
      isSqliteWorkerError(current, "outcome-unknown") ||
      (current instanceof Error &&
        readErrorName(current) === "SqliteWorkerError" &&
        extractErrorCode(current) === "outcome-unknown"),
  );
}
