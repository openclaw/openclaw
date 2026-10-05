import {
  collectErrorGraphCandidates,
  readErrorCauses,
} from "@openclaw/normalization-core/error-coercion";

export class SqliteSessionMutationConflictError extends Error {
  constructor(readonly operationLabel: string) {
    super(`SQLite session state changed while preparing ${operationLabel}`);
    this.name = "SqliteSessionMutationConflictError";
  }
}

export class SqliteTranscriptMutationConflictError extends Error {
  constructor(readonly sessionId: string) {
    super(`SQLite transcript changed while preparing rewrite for ${sessionId}`);
    this.name = "SqliteTranscriptMutationConflictError";
  }
}

export function isSqliteTranscriptMutationConflict(error: unknown): boolean {
  return collectErrorGraphCandidates(error, readErrorCauses).some(
    (candidate) => candidate instanceof SqliteTranscriptMutationConflictError,
  );
}

export class SessionEntryLifecycleUpsertConflictError extends Error {
  constructor(readonly sessionKey: string) {
    super(`SQLite session entry changed before lifecycle upsert for ${sessionKey}`);
    this.name = "SessionEntryLifecycleUpsertConflictError";
  }
}

export class SessionMaintenancePreservationConflictError extends Error {
  constructor() {
    super("Session maintenance protection changed before lifecycle commit");
    this.name = "SessionMaintenancePreservationConflictError";
  }
}
