export class SqliteIntegrityWorkerInterruptedError extends Error {
  constructor(
    readonly signal: NodeJS.Signals,
    lastObservedPhase: string,
  ) {
    super(
      `SQLite integrity check stopped by ${signal} before completion (lastObservedPhase=${lastObservedPhase})`,
    );
    this.name = "SqliteIntegrityWorkerInterruptedError";
  }
}
