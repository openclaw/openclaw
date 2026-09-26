import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  readErrorCauses,
} from "./errors.js";
import {
  formatSqliteErrorCodeSuffix,
  sqliteExtendedResultCode,
} from "./sqlite-error-diagnostics.js";

/** Keep acquisition failures distinct from contention when Doctor records a refusal. */
export function formatGatewayLockFailure(error: unknown): string {
  const causes = collectErrorGraphCandidates(error, readErrorCauses);
  const codes = new Set(causes.map(extractErrorCode));
  let guidance = "";
  if (codes.has("EACCES") || codes.has("EPERM") || codes.has("SQLITE_READONLY")) {
    guidance =
      "Check ownership and write permissions for the reported lock path under the OpenClaw user; containers need writable state and /tmp mounts.";
  } else if (codes.has("ENOSPC") || codes.has("SQLITE_FULL")) {
    guidance = "Free space on the filesystem containing the reported lock path, then retry.";
  } else if (codes.has("ENOSYS")) {
    guidance =
      "The required filesystem operation is unavailable. Upgrade OpenClaw and the container host/kernel, then retry.";
  } else if (
    codes.has("ENOTSUP") ||
    codes.has("EOPNOTSUPP") ||
    codes.has("SQLITE_IOERR_LOCK") ||
    causes.some((cause) => sqliteExtendedResultCode(cause) === 3850)
  ) {
    guidance =
      "Stop OpenClaw, back up the state directory, and use a local filesystem with SQLite locking for the state volume and a writable local /tmp in containers.";
  }
  return `${formatErrorMessage(error)}${formatSqliteErrorCodeSuffix(error)}${guidance ? `. ${guidance}` : ""}`;
}
