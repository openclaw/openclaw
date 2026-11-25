import type { SubsystemLogger } from "../logging/subsystem.js";

export type SqliteTransactionOptions = {
  /** Already-started BEGIN budget, carried between workers in the same process. */
  beginDeadlineNs?: bigint;
  /** An outer owner handles nonblocking admission failures. */
  beginLockFailureReporting?: "suppress";
  busyTimeoutMs?: number;
  databaseLabel?: string;
  /** Prepared identifiers and counts only; never transcript or session payloads. */
  diagnosticContext?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  logger?: Pick<SubsystemLogger, "warn">;
  operationLabel?: string;
  slowTransactionHoldMs?: number;
  /** Enclose the physical commit in an owner's synchronous authority guard. */
  withCommit?: (commit: () => void) => void;
};

export type SyncReturnGuard<Result> = [Extract<Result, PromiseLike<unknown>>] extends [never]
  ? unknown
  : never;

// Private worker boundaries reject inferred thenables; released transaction
// signatures and runtime guards for erased callback returns remain unchanged.
export type SynchronousSqliteCallback<Result> = () => Result & NoInfer<SyncReturnGuard<Result>>;

export type SqliteWorkerTransactionOptions<CommitResult = void> = Omit<
  SqliteTransactionOptions,
  "withCommit"
> & {
  withCommit?: ((commit: () => void) => CommitResult) & NoInfer<SyncReturnGuard<CommitResult>>;
};
