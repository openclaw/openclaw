import type { ConfigFileSnapshot } from "./types.js";

const JSON5_PARSE_FAILED_PREFIX = "JSON5 parse failed:";
const ENV_SUBSTITUTION_FAILED_PREFIX = "Env var substitution failed:";
const INCLUDE_RESOLUTION_FAILED_PREFIX = "Include resolution failed:";
const READ_FAILED_PREFIX = "read failed:";
const MISSING_ENV_VAR_PREFIX = "Missing env var ";

const INCLUDE_ERROR_PREFIXES = [
  INCLUDE_RESOLUTION_FAILED_PREFIX,
  "Failed to read include file:",
  "Failed to parse include file:",
  "Include path escapes config directory:",
  "Include path resolves outside config directory",
  "Include file failed security checks",
  "Maximum include depth",
  "Circular include",
];

function isMessageNonRecoverable(message: string): boolean {
  const trimmed = message.trim();
  return (
    trimmed.startsWith(ENV_SUBSTITUTION_FAILED_PREFIX) ||
    trimmed.startsWith(MISSING_ENV_VAR_PREFIX) ||
    trimmed.startsWith(READ_FAILED_PREFIX) ||
    INCLUDE_ERROR_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
  );
}

function isMessageParseFailure(message: string): boolean {
  return message.trim().startsWith(JSON5_PARSE_FAILED_PREFIX);
}

/**
 * Allow backup recovery only for likely config corruption:
 * - parse failures
 * - schema / validation failures
 *
 * Do not auto-recover for environment and host-specific issues (for example
 * missing `${VAR}`), include resolution, or filesystem read failures.
 */
export function shouldRecoverInvalidConfigSnapshot(snapshot: ConfigFileSnapshot): boolean {
  if (!snapshot.exists || snapshot.valid || snapshot.issues.length === 0) {
    return false;
  }
  if (snapshot.issues.some((issue) => isMessageParseFailure(issue.message))) {
    return true;
  }
  if (snapshot.issues.some((issue) => isMessageNonRecoverable(issue.message))) {
    return false;
  }
  return true;
}
