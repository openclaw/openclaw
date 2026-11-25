export type SqliteReadOnlyOperationContext = { path: string; env: NodeJS.ProcessEnv };
export type SqliteReadOnlyOperationExecutionContext = SqliteReadOnlyOperationContext & {
  /** Recheck the original child lifetime and physical source after asynchronous preparation. */
  assertCurrent: () => void;
};
export type SqliteReadOnlyOperationCommand = { type: string; input: unknown };
export type SqliteReadOnlyOperationResult = { operation: string; value: unknown };
