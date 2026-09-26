import { MessageChannel, MessagePort, receiveMessageOnPort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferredCore } from "../shared/deferred.js";
import { acquireWithWait } from "./acquire-with-wait.js";
import { sleepWithAbort } from "./backoff.js";
import {
  SqliteCoordinatorError,
  createSqliteLifecycleAggregateError,
} from "./sqlite-coordinator.js";
import {
  acquireStateDatabaseCoordinator,
  attachStateLifecycleDelegate,
  StateDatabaseCoordinatorContentionError,
  withStateDatabaseCoordinatorRuntimeDirectory,
  type StateDatabaseCoordinatorRuntime,
} from "./state-database-coordinator.js";

/** Service only this job's preparation while a legacy native caller owns the host turn. */
export function createSqliteWorkerLifecyclePreparation(params: {
  assertCurrent(): void;
  borrow(): MessagePort | undefined;
  admit(): MessagePort | undefined;
  dispatch(): void;
  receiveResult(reply: unknown, pumping: boolean): void;
  signal: AbortSignal;
}) {
  const { port1, port2 } = new MessageChannel();
  const prepared = createDeferredCore();
  let failure: unknown;
  let finished = false;
  let admitted = false;
  const refuse = (error: unknown) => {
    failure ??= error;
    port1.postMessage({ type: "cancel" });
  };
  const receive = (request: unknown, pumping = false) => {
    if (finished) {
      return;
    }
    if (isRecord(request) && request.type === "result") {
      params.receiveResult(request.reply, pumping);
      return;
    }
    if (!isRecord(request) || (request.type !== "check" && request.type !== "acquired")) {
      refuse(new SqliteCoordinatorError("SQLite lifecycle preparation request is invalid"));
      return;
    }
    try {
      params.signal.throwIfAborted();
      params.assertCurrent();
      if (admitted) {
        throw new SqliteCoordinatorError("SQLite lifecycle preparation already admitted its job");
      }
      if (request.type === "check") {
        const stateLifecycle = params.borrow();
        port1.postMessage(
          { type: "accepted", stateLifecycle },
          stateLifecycle ? [stateLifecycle] : [],
        );
        return;
      }
      const admission = params.admit();
      params.signal.throwIfAborted();
      params.assertCurrent();
      params.dispatch();
      admitted = true;
      port1.postMessage({ type: "accepted", admission }, admission ? [admission] : []);
      prepared.resolve();
    } catch (error) {
      refuse(error);
    }
  };
  const abort = () => refuse(params.signal.reason);
  port1.on("message", receive);
  port1.once("close", () => prepared.resolve());
  port1.unref();
  params.signal.addEventListener("abort", abort, { once: true });
  return {
    port: port2,
    prepared: prepared.promise,
    get failure() {
      return failure;
    },
    service() {
      for (let queued = receiveMessageOnPort(port1); queued; queued = receiveMessageOnPort(port1)) {
        receive(queued.message, true);
      }
    },
    finish() {
      finished = true;
      params.signal.removeEventListener("abort", abort);
      prepared.resolve();
      port1.close();
      port2.close();
    },
  };
}

/** The executing data worker owns acquisition, its synchronous command, and native release. */
export async function acquireSqliteWorkerLifecycle(params: {
  port: MessagePort;
  databasePath: string;
  actorId: string;
  deadlineNs: bigint;
  maxPollIntervalMs?: number;
  runtime: StateDatabaseCoordinatorRuntime;
  onUnsettled(): void;
}) {
  const controller = new AbortController();
  type Accepted = { admission?: MessagePort; stateLifecycle?: MessagePort };
  let waiting: ReturnType<typeof createDeferredCore<Accepted>> | undefined;
  const cancel = () => {
    const error = new SqliteCoordinatorError("SQLite lifecycle preparation was canceled");
    controller.abort(error);
    waiting?.reject(error);
  };
  const receive = (reply: unknown) => {
    if (!isRecord(reply) || reply.type !== "accepted") {
      cancel();
      return;
    }
    if (!waiting) {
      cancel();
      return;
    }
    const pending = waiting;
    waiting = undefined;
    if (
      (reply.admission !== undefined && !(reply.admission instanceof MessagePort)) ||
      (reply.stateLifecycle !== undefined && !(reply.stateLifecycle instanceof MessagePort))
    ) {
      pending.reject(new SqliteCoordinatorError("SQLite lifecycle admission port is invalid"));
      return;
    }
    pending.resolve({ admission: reply.admission, stateLifecycle: reply.stateLifecycle });
  };
  params.port.on("message", receive);
  params.port.once("close", cancel);
  const check = (type: "check" | "acquired") => {
    controller.signal.throwIfAborted();
    waiting = createDeferredCore<Accepted>();
    params.port.postMessage({ type }, []);
    return waiting.promise;
  };
  let coordinator: ReturnType<typeof acquireStateDatabaseCoordinator> | undefined;
  let delegate: Awaited<ReturnType<typeof attachStateLifecycleDelegate>> | undefined;
  try {
    await acquireWithWait({
      deadlineMs:
        performance.now() + Number(params.deadlineNs - process.hrtime.bigint()) / 1_000_000,
      pollIntervalMs: 25,
      maxPollIntervalMs: params.maxPollIntervalMs ?? 250,
      sleep: (ms) => sleepWithAbort(ms, controller.signal),
      shouldRetry: (error) =>
        error instanceof StateDatabaseCoordinatorContentionError &&
        error.family === "state-lifecycle",
      acquire: async () => {
        const checked = await check("check");
        controller.signal.throwIfAborted();
        if (checked.stateLifecycle) {
          delegate = await attachStateLifecycleDelegate(checked.stateLifecycle, {
            databasePath: params.databasePath,
            runtimeDirectory: params.runtime.directory,
            actorId: params.actorId,
          });
        } else {
          coordinator = withStateDatabaseCoordinatorRuntimeDirectory(params.runtime, () =>
            acquireStateDatabaseCoordinator({
              databasePath: params.databasePath,
              busyTimeoutMs: 0,
            }),
          );
        }
      },
    });
    const { admission } = await check("acquired");
    controller.signal.throwIfAborted();
    const prepared = { coordinator, delegate, admission };
    coordinator = undefined;
    delegate = undefined;
    return prepared;
  } catch (error) {
    delegate?.close();
    try {
      coordinator?.release();
    } catch (cleanupError) {
      params.onUnsettled();
      throw createSqliteLifecycleAggregateError(
        [error, cleanupError],
        "SQLite lifecycle preparation cleanup failed",
        error,
      );
    }
    throw error;
  } finally {
    params.port.off("message", receive);
    params.port.off("close", cancel);
    // The caller retains this port through terminal replies, including failed native cleanup.
  }
}
