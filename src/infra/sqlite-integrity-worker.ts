import { AsyncLocalStorage } from "node:async_hooks";
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
  reuse?: true;
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

type IntegrityProcess = {
  child: ReturnType<typeof fork>;
  closed: Promise<void>;
  retired: boolean;
  closeBudgetMs: number;
  failure?: Error;
};
type IntegrityQueue = { process?: IntegrityProcess; tail: Promise<void> };
type IntegrityScope = {
  queue: IntegrityQueue;
  assertCurrent: () => void;
  accepting: boolean;
  pending: Set<Promise<void>>;
};
const integrityScope = new AsyncLocalStorage<IntegrityScope>();

async function closeIntegrityProcess(worker: IntegrityProcess): Promise<void> {
  if (!worker.retired) {
    worker.retired = true;
    if (worker.child.connected) {
      // Child-initiated disconnect preserves the parent's close event on Node 26.
      worker.child.send({ type: "close" }, (error) => {
        if (error) {
          worker.child.kill("SIGKILL");
        }
      });
    }
  }
  const timeout = setTimeout(() => worker.child.kill("SIGKILL"), worker.closeBudgetMs);
  timeout.unref();
  try {
    await worker.closed;
  } finally {
    clearTimeout(timeout);
  }
}

/** Reuse imports within one maintenance lease; each request opens and closes its own database. */
export async function withSqliteIntegrityWorkerScope<T>(
  assertCurrent: () => void,
  operation: () => Promise<T>,
): Promise<T> {
  const parent = integrityScope.getStore();
  if (parent && !parent.accepting) {
    throw new Error("SQLite integrity maintenance scope is closed");
  }
  const scope: IntegrityScope = {
    queue: parent?.queue ?? { tail: Promise.resolve() },
    assertCurrent,
    accepting: true,
    pending: new Set(),
  };
  try {
    return await integrityScope.run(scope, async () => {
      let outcome: { value: T } | { error: unknown };
      try {
        outcome = { value: await operation() };
      } catch (error) {
        outcome = { error };
      }
      scope.accepting = false;
      const errors: unknown[] = "error" in outcome ? [outcome.error] : [];
      for (const result of await Promise.allSettled(scope.pending)) {
        if (result.status === "rejected" && !errors.includes(result.reason)) {
          errors.push(result.reason);
        }
      }
      try {
        assertCurrent();
      } catch (error) {
        if (!errors.includes(error)) {
          errors.push(error);
        }
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "SQLite integrity maintenance scope failed", {
          cause: errors[0],
        });
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if ("error" in outcome) {
        throw outcome.error;
      }
      return outcome.value;
    });
  } finally {
    scope.accepting = false;
    if (!parent && scope.queue.process) {
      await closeIntegrityProcess(scope.queue.process);
    }
  }
}

/** The caller retains its owning lease or private snapshot until the native reader closes. */
export function assertSqliteIntegrityInWorker(
  pathname: string,
  busyTimeoutMs: number,
  callerSignal: AbortSignal,
  databaseLabel = pathname,
  timing?: SqliteIntegrityCheckTiming,
): Promise<void> {
  const scope = integrityScope.getStore();
  if (!scope) {
    return assertSqliteIntegrityWithProcess(
      pathname,
      busyTimeoutMs,
      callerSignal,
      databaseLabel,
      timing,
    );
  }
  if (!scope.accepting) {
    return Promise.reject(new Error("SQLite integrity maintenance scope is closed"));
  }
  const pending = scope.queue.tail.then(async () => {
    try {
      if (scope.queue.process?.retired) {
        await scope.queue.process.closed;
      }
      await assertSqliteIntegrityWithProcess(
        pathname,
        busyTimeoutMs,
        callerSignal,
        databaseLabel,
        timing,
        scope,
      );
    } catch (error) {
      if (scope.queue.process) {
        await closeIntegrityProcess(scope.queue.process);
      }
      throw error;
    }
  });
  scope.queue.tail = pending.catch(() => undefined);
  scope.pending.add(pending);
  void pending.finally(() => scope.pending.delete(pending)).catch(() => undefined);
  return pending;
}

function assertSqliteIntegrityWithProcess(
  pathname: string,
  busyTimeoutMs: number,
  callerSignal: AbortSignal,
  databaseLabel: string,
  timing?: SqliteIntegrityCheckTiming,
  scope?: IntegrityScope,
): Promise<void> {
  const signal = resolveSqliteInspectionSignal(callerSignal) ?? callerSignal;
  if (timing) {
    delete timing.workerCheckElapsedMs;
    delete timing.workerLifetimeElapsedMs;
  }
  signal.throwIfAborted();
  scope?.assertCurrent();
  // The caller retains its owning lease through native close. This witness
  // detects observed path swaps; it is not native descriptor authority.
  const identity = readSqliteIntegrityFileIdentity(pathname);
  const { timeoutMs, size } = readSqliteInspectionBudget(
    "integrity check",
    databaseLabel,
    identity.size,
  );
  const startedAt = timing ? performance.now() : 0;
  let active = scope?.queue.process;
  if (!active || active.retired) {
    const entry = resolveRuntimeProcessEntrypointUrl("sqliteIntegrity");
    const child = fork(entry, [], {
      execArgv: resolveRuntimeWorkerArgv(entry).slice(0, -1),
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      timeout: scope || isSqliteInspectionDeadlineOwnedByCaller() ? undefined : timeoutMs,
      killSignal: "SIGKILL",
      ...(scope ? {} : { signal }),
    });
    let onClosed!: () => void;
    active = {
      child,
      closed: new Promise<void>((resolve) => {
        onClosed = resolve;
      }),
      retired: false,
      closeBudgetMs: timeoutMs,
    };
    const launched = active;
    child.on("error", (error) => {
      launched.failure = toStringifiedError(error);
      launched.retired = true;
      child.kill("SIGKILL");
    });
    child.once("close", () => {
      launched.retired = true;
      onClosed();
    });
    if (scope) {
      scope.queue.process = active;
    }
  }
  active.closeBudgetMs = timeoutMs;
  const reader = active;
  const worker = reader.child;
  return new Promise<void>((resolve, reject) => {
    let result: SqliteIntegrityWorkerResult | undefined;
    let failure: Error | undefined;
    let lastObservedPhase: SqliteIntegrityWorkerPhase | "starting" | "result-received" = "starting";
    let timeout: NodeJS.Timeout | undefined;
    const deadlineError = () => {
      const error = sqliteInspectionTimeoutError("integrity check", databaseLabel, timeoutMs, size);
      error.message += ` (lastObservedPhase=${lastObservedPhase})`;
      return error;
    };
    const kill = () => {
      reader.retired = true;
      worker.kill("SIGKILL");
    };
    const onAbort = () => {
      failure = toStringifiedError(signal.reason);
      kill();
    };
    const finish = (code: number | null, closeSignal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      worker.off("message", onMessage);
      worker.off("close", onClose);
      if (timing) {
        // In a reused child, lifetime measures this request through native close.
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
        scope?.assertCurrent();
        const workerFailure = failure ?? reader.failure;
        if (workerFailure) {
          throw workerFailure;
        }
        if (worker.killed && closeSignal === "SIGKILL") {
          throw deadlineError();
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
        if (scope && !reader.retired) {
          kill();
          void reader.closed.then(() => reject(toStringifiedError(error)));
        } else {
          reject(toStringifiedError(error));
        }
      }
    };
    const onClose = (code: number | null, closeSignal: NodeJS.Signals | null) =>
      finish(code, closeSignal);
    const onMessage = (message: SqliteIntegrityWorkerMessage) => {
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
        if (scope) {
          if (message.ok && !reader.retired && !failure && !reader.failure) {
            finish(0, null);
          } else {
            // Failed native close can retain a handle. Never resume until process exit.
            reader.retired = true;
          }
        }
      }
    };
    worker.on("message", onMessage);
    worker.once("close", onClose);
    if (scope) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (!isSqliteInspectionDeadlineOwnedByCaller()) {
        timeout = setTimeout(() => {
          // Native exit can win the signal race while its IPC and close callbacks still wait.
          if (!result || result.ok) {
            failure ??= reader.failure ?? deadlineError();
          }
          kill();
        }, timeoutMs);
        timeout.unref();
      }
    }
    if (!signal.aborted) {
      worker.send(
        {
          pathname,
          databaseLabel,
          identity,
          busyTimeoutMs,
          ...(scope ? { reuse: true as const } : {}),
        } satisfies SqliteIntegrityWorkerInput,
        (error) => {
          if (error) {
            failure = error;
            kill();
          }
        },
      );
    } else if (scope) {
      onAbort();
    }
  });
}
