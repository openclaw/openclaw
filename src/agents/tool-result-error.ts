import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

const TOOL_RESULT_FAILURE_STATUSES = new Map<string, ToolResultFailureKind>([
  ["error", "failed"],
  ["failed", "failed"],
  ["failure", "failed"],
  ["timeout", "timed_out"],
  ["timed_out", "timed_out"],
  ["blocked", "blocked"],
  ["denied", "blocked"],
  ["forbidden", "blocked"],
  ["unavailable", "failed"],
  ["approval-unavailable", "blocked"],
  ["disabled", "blocked"],
  ["aborted", "cancelled"],
  ["cancelled", "cancelled"],
  ["canceled", "cancelled"],
  ["killed", "cancelled"],
  ["invalid", "failed"],
]);

export function readToolErrorField(error: object, key: string): unknown {
  try {
    return key in error ? (error as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

export function readToolResultDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  try {
    return asOptionalRecord(readToolErrorField(result, "details"));
  } catch {
    return undefined;
  }
}

export function readToolResultStatus(result: unknown): string | undefined {
  const details = readToolResultDetails(result);
  return normalizeOptionalLowercaseString(
    details ? readToolErrorField(details, "status") : undefined,
  );
}

export function isToolResultError(result: unknown): boolean {
  return resolveToolResultFailureKind(result) !== undefined;
}

export type ToolResultFailureKind = "blocked" | "cancelled" | "failed" | "timed_out";

/** Classify a resolved structured tool result through the shared terminal contract. */
export function resolveToolResultFailureKind(result: unknown): ToolResultFailureKind | undefined {
  const details = readToolResultDetails(result);
  if (!details) {
    return undefined;
  }
  const status = normalizeOptionalLowercaseString(readToolErrorField(details, "status"));
  const statusKind = TOOL_RESULT_FAILURE_STATUSES.get(status ?? "");
  const ok = readToolErrorField(details, "ok");
  const success = readToolErrorField(details, "success");
  const timedOut = readToolErrorField(details, "timedOut") === true;
  const exitCode = readToolErrorField(details, "exitCode");
  if (
    ok !== false &&
    success !== false &&
    (!statusKind || ok === true || success === true) &&
    !timedOut &&
    !readToolErrorField(details, "error") &&
    (status === "completed" ||
      typeof exitCode !== "number" ||
      !Number.isFinite(exitCode) ||
      exitCode === 0)
  ) {
    return undefined;
  }
  if (statusKind === "blocked") {
    return "blocked";
  }
  return timedOut ? "timed_out" : (statusKind ?? "failed");
}
