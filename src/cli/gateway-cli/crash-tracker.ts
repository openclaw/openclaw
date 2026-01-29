// src/cli/gateway-cli/crash-tracker.ts
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isTransientNetworkError } from "../../infra/unhandled-rejections.js";

const log = createSubsystemLogger("gateway");

export type CrashErrorType =
  | "fetch_failed"
  | "network_error"
  | "startup_error"
  | "runtime_error"
  | "unknown";

export type CrashRecord = {
  timestamp: number;
  errorType: CrashErrorType;
  errorMessage: string;
  uptimeMs: number;
  backoffMs: number;
  consecutiveFailures: number;
};

const MAX_CRASH_HISTORY = 20;
const recentCrashes: CrashRecord[] = [];

export function recordCrash(record: Omit<CrashRecord, "timestamp">): void {
  const full: CrashRecord = { ...record, timestamp: Date.now() };
  recentCrashes.push(full);
  if (recentCrashes.length > MAX_CRASH_HISTORY) {
    recentCrashes.shift();
  }

  log.error("gateway_crash", {
    errorType: record.errorType,
    errorMessage: record.errorMessage,
    uptimeMs: record.uptimeMs,
    backoffMs: record.backoffMs,
    consecutiveFailures: record.consecutiveFailures,
    crashesInLastHour: getCrashesInLastHour(),
  });
}

export function getRecentCrashes(): readonly CrashRecord[] {
  return recentCrashes;
}

export function getCrashesInLastHour(): number {
  const oneHourAgo = Date.now() - 3600_000;
  return recentCrashes.filter((c) => c.timestamp > oneHourAgo).length;
}

export function clearCrashes(): void {
  recentCrashes.length = 0;
}

// Network error patterns to match in error messages
const FETCH_FAILED_PATTERNS = ["fetch failed", "econnrefused"];
const NETWORK_ERROR_PATTERNS = [
  "econnreset",
  "etimedout",
  "enotfound",
  "ehostunreach",
  "enetunreach",
  "network unreachable",
  "socket hang up",
];

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return "";
}

export function classifyError(err: unknown): CrashErrorType {
  if (!err) return "unknown";

  const message = getErrorMessage(err).toLowerCase();

  // Use existing transient network detection for consistency
  if (isTransientNetworkError(err)) {
    if (FETCH_FAILED_PATTERNS.some((p) => message.includes(p))) {
      return "fetch_failed";
    }
    return "network_error";
  }

  // Also check message patterns for errors without proper error codes
  if (FETCH_FAILED_PATTERNS.some((p) => message.includes(p))) {
    return "fetch_failed";
  }
  if (NETWORK_ERROR_PATTERNS.some((p) => message.includes(p))) {
    return "network_error";
  }

  if (message.includes("startup") || message.includes("init")) {
    return "startup_error";
  }
  return "runtime_error";
}
