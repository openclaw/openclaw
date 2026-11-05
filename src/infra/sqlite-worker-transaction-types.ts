import type { SqliteTransactionOptions } from "./sqlite-transaction.js";

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
