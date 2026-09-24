import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type OpenClawDatabaseKind = "agent" | "state";
export type OpenClawDatabaseQuarantine = {
  kind: OpenClawDatabaseKind;
  quarantinedAt: number;
  reason: string;
};

export const DATABASE_QUARANTINE_READ_CLEANUP_ERROR_NAME = "OpenClawQuarantineReadCleanupError";

// Source and compiled worker modules must recognize the same cleanup error identity.
export const OpenClawQuarantineReadCleanupError = resolveGlobalSingleton(
  Symbol.for("openclaw.quarantineReadCleanupError"),
  () =>
    class QuarantineReadCleanupError extends AggregateError {
      constructor(
        errors: unknown[],
        readonly quarantine?: OpenClawDatabaseQuarantine,
      ) {
        super(errors, "OpenClaw quarantine reader cleanup failed.", { cause: errors[0] });
        this.name = DATABASE_QUARANTINE_READ_CLEANUP_ERROR_NAME;
      }
    },
);
export type OpenClawQuarantineReadCleanupError = InstanceType<
  typeof OpenClawQuarantineReadCleanupError
>;
