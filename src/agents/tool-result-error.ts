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

export function isFailureToolResultStatus(status: string | undefined): status is string {
  return (
    status === "error" ||
    status === "failed" ||
    status === "failure" ||
    status === "timeout" ||
    status === "timed_out" ||
    status === "blocked" ||
    status === "denied" ||
    status === "forbidden" ||
    status === "unavailable" ||
    status === "approval-unavailable" ||
    status === "disabled" ||
    status === "aborted" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "killed" ||
    status === "invalid"
  );
}

export function isToolResultError(result: unknown): boolean {
  const details = readToolResultDetails(result);
  const normalized = readToolResultStatus(result);
  const explicitlySuccessful = details?.ok === true || details?.success === true;
  if (details?.ok === false || details?.success === false) {
    return true;
  }
  if (isFailureToolResultStatus(normalized) && !explicitlySuccessful) {
    return true;
  }
  if (details?.timedOut === true || Boolean(details?.error)) {
    return true;
  }
  const exitCode = details?.exitCode;
  return typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0;
}
