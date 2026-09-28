import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export class OpenClawStateOwnershipError extends Error {}

export class OpenClawStateOwnershipMetadataError extends OpenClawStateOwnershipError {
  constructor(
    readonly databasePath: string,
    message: string,
  ) {
    super(
      `OpenClaw shared state ownership metadata is invalid at ${databasePath}: ${message}. ` +
        "Repair it with OPENCLAW_SUPERVISOR_MODE=external openclaw database ownership claim --manager <manager-id>.",
    );
    this.name = "OpenClawStateOwnershipMetadataError";
  }
}

export class OpenClawStateExternalOwnershipError extends OpenClawStateOwnershipError {
  constructor(
    readonly databasePath: string,
    readonly managerId: string,
  ) {
    super(
      `OpenClaw shared state database ${databasePath} is externally supervised by ${managerId}. ` +
        "Use that external supervisor with OPENCLAW_SUPERVISOR_MODE=external for writable operations.",
    );
    this.name = "OpenClawStateExternalOwnershipError";
  }
}

// Worker error envelopes retain this name and identity across module reloads.
export const SqliteCoordinatorError = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteCoordinatorError"),
  () =>
    class CoordinatorError extends Error {
      constructor(
        message: string,
        public override readonly cause?: unknown,
      ) {
        super(message);
        this.name = "SqliteCoordinatorError";
      }
    },
);
export type SqliteCoordinatorError = InstanceType<typeof SqliteCoordinatorError>;

export function createSqliteLifecycleAggregateError(
  errors: unknown[],
  message: string,
  cause: unknown,
): AggregateError {
  return new AggregateError(errors, message, { cause });
}

/** Keep the first failure as the cause while retaining independent cleanup errors. */
export function throwSqliteLifecycleErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw createSqliteLifecycleAggregateError(errors, message, errors[0]);
  }
}

/** Settle a synchronous SQLite operation and preserve both operation and cleanup failures. */
export function runWithSqliteCleanup<T>(
  resource: { release: () => void },
  operationLabel: string,
  operation: () => T,
): T {
  let result: T;
  try {
    result = operation();
    if (isPromiseLike(result)) {
      throw new SqliteCoordinatorError(`${operationLabel} must remain synchronous`);
    }
  } catch (operationError) {
    let releaseFailed = false;
    let releaseError: unknown;
    try {
      resource.release();
    } catch (error) {
      releaseFailed = true;
      releaseError = error;
    }
    if (releaseFailed) {
      throw createSqliteLifecycleAggregateError(
        [operationError, releaseError],
        `${operationLabel} and resource release both failed`,
        operationError,
      );
    }
    throw operationError;
  }
  try {
    resource.release();
  } catch (releaseError) {
    throw new SqliteCoordinatorError(
      `${operationLabel} completed, but releasing its resource failed`,
      releaseError,
    );
  }
  return result;
}
