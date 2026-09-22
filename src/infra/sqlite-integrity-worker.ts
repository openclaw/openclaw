import { fork } from "node:child_process";
import { performance } from "node:perf_hooks";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import type { FileIdentityStat } from "./fs-safe-advanced.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "./runtime-worker-url.js";
import { readSqliteIntegrityFileIdentity } from "./sqlite-file-generation.js";
import { SqliteIntegrityWorkerInterruptedError } from "./sqlite-integrity-worker-error.js";
import type { SqliteIntegrityCheckTiming } from "./sqlite-integrity.js";
import {
  isSqliteInspectionDeadlineOwnedByCaller,
  readSqliteInspectionBudget,
  resolveSqliteInspectionSignal,
  sqliteInspectionTimeoutError,
} from "./sqlite-readonly-worker.js";

export type SqliteIntegrityWorkerInput = {
  pathname: string;
  databaseLabel: string;
  identity: FileIdentityStat;
  busyTimeoutMs: number;
};

export type SqliteIntegrityWorkerResult =
  | { ok: true; checkElapsedMs?: number }
  | {
      ok: false;
      checkElapsedMs?: number;
      error: {
        name: string;
        message: string;
        code?: string;
        errcode?: number;
        cause?: { message: string; code?: string; errcode?: number };
      };
    };

export type SqliteIntegrityWorkerPhase = "opening" | "checking" | "closing";

export type SqliteIntegrityWorkerMessage =
  | SqliteIntegrityWorkerResult
  | { type: "phase"; phase: SqliteIntegrityWorkerPhase };

/** The caller retains its owning lease or private snapshot until the read-only child closes. */
export function assertSqliteIntegrityInWorker(
  pathname: string,
  busyTimeoutMs: number,
  callerSignal: AbortSignal,
  databaseLabel = pathname,
  timing?: SqliteIntegrityCheckTiming,
): Promise<void> {
  const signal = resolveSqliteInspectionSignal(callerSignal) ?? callerSignal;
  if (timing) {
    delete timing.workerCheckElapsedMs;
    delete timing.workerLifetimeElapsedMs;
  }
  signal.throwIfAborted();
  // The caller retains its owning lease through native exit. This witness
  // detects observed path swaps; it is not native descriptor authority.
  const identity = readSqliteIntegrityFileIdentity(pathname);
  const { timeoutMs, size } = readSqliteInspectionBudget(
    "integrity check",
    databaseLabel,
    identity.size,
  );
  const entry = resolveRuntimeProcessEntrypointUrl("sqliteIntegrity");
  const startedAt = timing ? performance.now() : 0;
  const worker = fork(entry, [], {
    execArgv: resolveRuntimeWorkerArgv(entry).slice(0, -1),
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    timeout: isSqliteInspectionDeadlineOwnedByCaller() ? undefined : timeoutMs,
    killSignal: "SIGKILL",
    signal,
  });
  return new Promise((resolve, reject) => {
    let result: SqliteIntegrityWorkerResult | undefined;
    let failure: Error | undefined;
    let lastObservedPhase: SqliteIntegrityWorkerPhase | "starting" | "result-received" = "starting";
    worker.on("message", (message: SqliteIntegrityWorkerMessage) => {
      if ("type" in message && message.type === "phase") {
        if (
          !result &&
          (message.phase === "opening" ||
            message.phase === "checking" ||
            message.phase === "closing")
        ) {
          lastObservedPhase = message.phase;
        }
      } else if ("ok" in message) {
        result = message;
        lastObservedPhase = "result-received";
      }
    });
    worker.on("error", (error) => {
      failure = toStringifiedError(error);
    });
    // Native cancellation/timeout kills the child; ownership ends only at close.
    worker.once("close", (code, closeSignal) => {
      if (timing) {
        timing.workerLifetimeElapsedMs = performance.now() - startedAt;
        const checkElapsedMs = result?.checkElapsedMs;
        if (
          typeof checkElapsedMs === "number" &&
          Number.isFinite(checkElapsedMs) &&
          checkElapsedMs >= 0
        ) {
          timing.workerCheckElapsedMs = checkElapsedMs;
        }
      }
      try {
        signal.throwIfAborted();
        if (failure) {
          throw failure;
        }
        if (worker.killed && closeSignal === "SIGKILL") {
          const error = sqliteInspectionTimeoutError(
            "integrity check",
            databaseLabel,
            timeoutMs,
            size,
          );
          error.message += ` (lastObservedPhase=${lastObservedPhase})`;
          throw error;
        }
        if (code !== 0 || !result) {
          if (!result && closeSignal) {
            throw new SqliteIntegrityWorkerInterruptedError(closeSignal, lastObservedPhase);
          }
          throw new Error(
            `SQLite integrity worker exited ${code} without a completed check (lastObservedPhase=${lastObservedPhase})`,
          );
        }
        readSqliteIntegrityFileIdentity(pathname, identity);
        if (!result.ok) {
          const cause = result.error.cause
            ? Object.assign(new Error(result.error.cause.message), result.error.cause)
            : undefined;
          throw Object.assign(new Error(result.error.message, cause ? { cause } : undefined), {
            name: result.error.name,
            code: result.error.code,
            errcode: result.error.errcode,
          });
        }
        resolve();
      } catch (error) {
        reject(toStringifiedError(error));
      }
    });
    if (!signal.aborted) {
      worker.send(
        { pathname, databaseLabel, identity, busyTimeoutMs } satisfies SqliteIntegrityWorkerInput,
        (error) => {
          if (error) {
            failure = error;
            worker.kill("SIGKILL");
          }
        },
      );
    }
  });
}
