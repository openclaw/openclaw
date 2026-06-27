import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

export function readToolResultDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  return record.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? (record.details as Record<string, unknown>)
    : undefined;
}

export function readToolResultStatus(result: unknown): string | undefined {
  return normalizeOptionalLowercaseString(readToolResultDetails(result)?.status);
}

export function isToolResultError(result: unknown): boolean {
  const details = readToolResultDetails(result);
  const normalized = readToolResultStatus(result);
  // sessions_spawn with status "accepted" is never an error (#96833).
  // Child session was successfully launched — the tool name happens to
  // contain "spawn" but the result is a successful handoff.
  if (normalized === "accepted") {
    return false;
  }
  const explicitlySuccessful = details?.ok === true || details?.success === true;
  if (details?.ok === false || details?.success === false) {
    return true;
  }
  const hasFailureStatus =
    normalized === "error" ||
    normalized === "failed" ||
    normalized === "failure" ||
    normalized === "timeout" ||
    normalized === "timed_out" ||
    normalized === "blocked" ||
    normalized === "denied" ||
    normalized === "forbidden" ||
    normalized === "unavailable" ||
    normalized === "approval-unavailable" ||
    normalized === "disabled" ||
    normalized === "aborted" ||
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "killed" ||
    normalized === "invalid";
  if (hasFailureStatus && !explicitlySuccessful) {
    return true;
  }
  if (details?.timedOut === true || Boolean(details?.error)) {
    return true;
  }
  const exitCode = details?.exitCode;
  return typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0;
}
