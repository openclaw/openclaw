export class SqliteSessionMutationConflictError extends Error {
  constructor(readonly operationLabel: string) {
    super(`SQLite session state changed while preparing ${operationLabel}`);
    this.name = "SqliteSessionMutationConflictError";
  }
}
