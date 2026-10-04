export class SqliteSessionMutationConflictError extends Error {
  constructor(readonly operationLabel: string) {
    super(`SQLite session state changed while preparing ${operationLabel}`);
    this.name = "SqliteSessionMutationConflictError";
  }
}

export class SessionEntryLifecycleUpsertConflictError extends Error {
  constructor(readonly sessionKey: string) {
    super(`SQLite session entry changed before lifecycle upsert for ${sessionKey}`);
    this.name = "SessionEntryLifecycleUpsertConflictError";
  }
}
