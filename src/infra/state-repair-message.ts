import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import {
  classifyGatewayStorageFailure,
  isSqliteCorruptionError,
} from "./sqlite-error-diagnostics.js";
import { SqliteIntegrityError } from "./sqlite-integrity.js";

export function formatDoctorStateRepairFailure(problem: string, recovery: string): string {
  return `Doctor cannot repair this state: ${problem}. ${recovery}`;
}

/** Shared diagnosis for a refused state inspection; callers own the operation prefix. */
export function describeUnreadableStateDatabase(
  path: string,
  reason: string,
  options?: ErrorOptions,
): { problem: string; recovery: string } {
  const corrupted = collectNestedErrorCandidates(options?.cause).some(
    (cause) =>
      isSqliteCorruptionError(cause) ||
      /^SQLITE_(?:CORRUPT|NOTADB)(?:_|$)/u.test(extractErrorCode(cause) ?? "") ||
      (cause instanceof SqliteIntegrityError && cause.findings !== undefined),
  );
  if (!corrupted) {
    const ioFailure = classifyGatewayStorageFailure(options?.cause) === "SQLITE_IOERR";
    return {
      problem: `shared state database inspection ${ioFailure ? "did not complete" : "was interrupted"} at ${path}: ${reason}`,
      recovery: ioFailure
        ? "Check disk health and available disk space or quota, then rerun the command. The database was left unchanged."
        : "Please rerun the command; if it repeats, check host load and available disk space or quota. The database was left unchanged.",
    };
  }
  return {
    problem: `shared state database is unreadable at ${path}: ${reason}`,
    recovery:
      "Stop OpenClaw processes, then restore this file from a verified backup; the unreadable database was left unchanged.",
  };
}

export class DoctorUnreadableStateDatabaseError extends Error {
  constructor(path: string, reason: string, options?: ErrorOptions) {
    const { problem, recovery } = describeUnreadableStateDatabase(path, reason, options);
    super(formatDoctorStateRepairFailure(problem, recovery), options);
    this.name = "DoctorUnreadableStateDatabaseError";
  }
}
