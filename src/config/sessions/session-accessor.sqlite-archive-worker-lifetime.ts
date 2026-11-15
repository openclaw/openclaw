import fs from "node:fs/promises";
import type { Worker } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { createSubsystemLogger } from "../../logging/subsystem.js";

export const SQLITE_ARCHIVE_TASK_TIMEOUT_MS = 180_000;
export const SQLITE_WORKER_RETIREMENT_GRACE_MS = 5_000;

/** A deadline never releases native custody; only the process lifecycle may recover a stuck join. */
export function watchSqliteWorkerSettlement(settlement: Promise<unknown>, taskTimeoutMs = 0): void {
  let pending = true;
  const deadline = setTimeout(() => {
    void import("../../infra/gateway-native-worker-recovery.js")
      .then(({ requestGatewayNativeWorkerRecovery }) =>
        requestGatewayNativeWorkerRecovery({ isCurrent: () => pending }),
      )
      .then(
        (result) => createSubsystemLogger("session-sqlite").warn(result.reason),
        (error: unknown) =>
          createSubsystemLogger("session-sqlite").error(
            `Native SQLite worker recovery failed: ${toStringifiedError(error).message}. Restart the Gateway before retrying.`,
          ),
      );
  }, taskTimeoutMs + SQLITE_WORKER_RETIREMENT_GRACE_MS);
  deadline.unref();
  const settled = () => {
    pending = false;
    clearTimeout(deadline);
  };
  void settlement.then(settled, settled);
}

const cleanups = new WeakMap<Worker, Promise<void>>();

/** Paired worker messages are delivered before exit; cleanup never overlaps native I/O. */
export function trackSqliteArchiveWorkerCleanup(
  worker: Worker,
  finishAdmission: () => Promise<void>,
): void {
  const paths = new Set<string>();
  worker.on("message", (message: { type: string; filePath: string; retained: boolean }) => {
    if (message.type === "archive-temporary-file") {
      if (message.retained) {
        paths.add(message.filePath);
      } else {
        paths.delete(message.filePath);
      }
    }
  });
  const cleanup = new Promise<void>((resolve, reject) => {
    worker.once("exit", () => {
      void (async () => {
        const admission = await Promise.allSettled([Promise.resolve().then(finishAdmission)]);
        const artifacts = await Promise.allSettled(
          [...paths].map((filePath) => fs.rm(filePath, { force: true })),
        );
        const errors = [...admission, ...artifacts].flatMap((result) =>
          result.status === "rejected" ? [toStringifiedError(result.reason)] : [],
        );
        const firstError = errors[0];
        if (firstError) {
          throw errors.length === 1
            ? firstError
            : new AggregateError(errors, "SQLite archive worker cleanup failed", {
                cause: firstError,
              });
        }
      })().then(resolve, reject);
    });
  });
  cleanups.set(worker, cleanup);
  void cleanup.catch(() => {});
}

export function joinSqliteArchiveWorkerCleanup(worker: Worker): Promise<void> | undefined {
  return cleanups.get(worker);
}
