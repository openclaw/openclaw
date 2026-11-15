import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  readErrorCauses,
} from "./errors.js";
import { formatSqliteErrorCodeSuffix } from "./sqlite-error-diagnostics.js";

/** Keep acquisition failures distinct from contention when Doctor records a refusal. */
export function formatGatewayLockFailure(error: unknown): string {
  const causes = collectErrorGraphCandidates(error, readErrorCauses);
  const codes = new Set(causes.map(extractErrorCode));
  let guidance = "";
  if (codes.has("EACCES") || codes.has("EPERM")) {
    guidance =
      "Check ownership and write permissions for the reported lock path under the OpenClaw user; containers need a writable state mount.";
  } else if (codes.has("ENOSPC")) {
    guidance =
      "Free space or inodes on the filesystem containing the reported lock path, then retry.";
  } else if (codes.has("ENOSYS")) {
    guidance =
      "The required filesystem operation is unavailable. Upgrade OpenClaw and the container host/kernel, then retry.";
  } else if (codes.has("ENOTSUP") || codes.has("EOPNOTSUPP")) {
    guidance =
      "Stop OpenClaw, back up the state directory, and use a local filesystem that supports exclusive file creation for state ownership.";
  }
  return `${formatErrorMessage(error)}${formatSqliteErrorCodeSuffix(error)}${guidance ? `. ${guidance}` : ""}`;
}
