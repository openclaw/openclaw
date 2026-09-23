export class SessionEntryLifecycleUpsertConflictError extends Error {
  constructor(readonly sessionKey: string) {
    super(`SQLite session entry changed before lifecycle upsert for ${sessionKey}`);
    this.name = "SessionEntryLifecycleUpsertConflictError";
  }
}
