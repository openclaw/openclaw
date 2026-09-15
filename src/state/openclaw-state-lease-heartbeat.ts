import { Worker } from "node:worker_threads";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  acquireStateDatabaseHandleLease,
  retainHeldStateDatabaseCoordinator,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createLeaseHeartbeatCleanup,
  type LeaseHeartbeatCleanup,
} from "./openclaw-state-lease-heartbeat-cleanup.js";
import {
  leaseHeartbeatState as state,
  LEASE_HEARTBEAT_START_TIMEOUT_MS,
  type LeaseHeartbeatReply,
  type LeaseHeartbeatRequest,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "./openclaw-state-worker-error.js";

export type { LeaseHeartbeatCleanup } from "./openclaw-state-lease-heartbeat-cleanup.js";

const WORKER_RESPONSE_TIMEOUT_MS = 1_000;

/** Parent-scheduled renewal; the lease owner retains each actor operation and its settlement. */
export function startOpenClawStateLeaseTimer(params: {
  observation: BigInt64Array<SharedArrayBuffer>;
  heartbeatMs: number;
  renew(): Promise<void>;
  onRenewError(error: unknown): void;
  onLost(error: Error): void;
}) {
  let stopped = false;
  let expiryClosed = false;
  let renewal: Promise<void> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const heartbeat = setInterval(() => {
    if (stopped || renewal) {
      return;
    }
    const pending = (async () => {
      await params.renew();
    })();
    renewal = pending;
    void pending.then(
      () => {
        renewal = undefined;
      },
      (error: unknown) => {
        renewal = undefined;
        params.onRenewError(error);
      },
    );
  }, params.heartbeatMs);
  heartbeat.unref?.();
  const checkExpiry = () => {
    if (expiryClosed) {
      return;
    }
    // Commit publication can precede the actor reply in the parent's event queue.
    const remainingMs = Number(Atomics.load(params.observation, state.expiresAt)) - Date.now();
    if (remainingMs <= 0) {
      stopped = true;
      expiryClosed = true;
      clearInterval(heartbeat);
      params.onLost(new Error("state lease expired"));
      return;
    }
    expiryTimer = setTimeout(checkExpiry, remainingMs);
    expiryTimer.unref?.();
  };
  try {
    checkExpiry();
  } catch (error) {
    clearInterval(heartbeat);
    clearTimeout(expiryTimer);
    throw error;
  }
  const stopRenewal = async () => {
    stopped = true;
    clearInterval(heartbeat);
    if (renewal) {
      // The lease owner handles the error; stopping must still join native settlement.
      await Promise.allSettled([renewal]);
    }
  };
  return {
    isExpired: () => Number(Atomics.load(params.observation, state.expiresAt)) <= Date.now(),
    stopRenewal,
    async close() {
      await stopRenewal();
      expiryClosed = true;
      clearTimeout(expiryTimer);
    },
  };
}

type PendingHeartbeatRequest = {
  deferred: ReturnType<typeof createDeferredCore<number>>;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
};

export function startOpenClawStateLeaseHeartbeat(
  params: Omit<
    LeaseHeartbeatWorkerData,
    "shared" | "parentCoordinatorRetained" | "retainedStartup"
  > & {
    /** The caller retains its shared-state actor through startup and failure teardown. */
    startupContext?: OpenClawStateWorkerContext;
    retainCleanup?: (cleanup: LeaseHeartbeatCleanup) => void;
    expiresAt: number;
    onLost: (error: Error) => void;
  },
) {
  const { startupContext } = params;
  startupContext?.admission.assertCurrent();
  if (startupContext && params.path !== startupContext.admission.databasePath) {
    throw new Error("state lease heartbeat path differs from its captured admission");
  }
  const databasePath = startupContext?.admission.databasePath ?? params.path;
  const retainedStartup = startupContext
    ? {
        expectedIdentity: startupContext.admission.identity.key,
        coordinatorRuntime: { ...startupContext.coordinatorRuntime },
      }
    : undefined;
  if (retainedStartup && !retainedStartup.expectedIdentity.startsWith("file:")) {
    throw new Error("state lease heartbeat requires an established database identity");
  }
  const startedAt = performance.now();
  const shared = new BigInt64Array(new SharedArrayBuffer(4 * BigInt64Array.BYTES_PER_ELEMENT));
  const ready = createDeferredCore();
  // Synchronous startup failures can occur before the caller receives ready.
  void ready.promise.catch(() => {});
  const pending = new Map<number, PendingHeartbeatRequest>();
  let nextRequestId = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const rejectPending = (error: Error) => {
    for (const reply of pending.values()) {
      clearTimeout(reply.timer);
      reply.deferred.reject(error);
    }
    pending.clear();
  };
  const close = () => {
    Atomics.store(shared, state.status, state.closed);
    Atomics.notify(shared, state.ack);
    clearTimeout(startTimer);
    clearTimeout(expiryTimer);
    const error = new Error("state lease heartbeat closed");
    ready.reject(error);
    rejectPending(error);
  };
  const lifecycle = createLeaseHeartbeatCleanup({
    cancel: close,
    onReleaseFailed: (cause) =>
      fail(new Error("state lease heartbeat handle release failed", { cause })),
  });
  const assertRunning = () => {
    // This checks only local lifetime; verify() owns the fresh durable check.
    if (Atomics.load(shared, state.status) !== state.ready) {
      throw new Error("state lease heartbeat is not running");
    }
  };
  let lossReported = false;
  const fail = (error: Error) => {
    if (lossReported || Atomics.load(shared, state.status) === state.closed) {
      return;
    }
    lossReported = true;
    Atomics.store(shared, state.status, state.lost);
    Atomics.notify(shared, state.ack);
    clearTimeout(startTimer);
    clearTimeout(expiryTimer);
    ready.reject(error);
    rejectPending(error);
    params.onLost(error);
  };
  const remainingLeaseMs = () => Number(Atomics.load(shared, state.expiresAt)) - Date.now();
  const watchExpiry = () => {
    clearTimeout(expiryTimer);
    const observedStatus = Atomics.load(shared, state.status);
    if (observedStatus === state.closed) {
      return;
    }
    if (observedStatus !== state.ready) {
      fail(new Error("state lease heartbeat is not running"));
      return;
    }
    const remainingMs = remainingLeaseMs();
    if (remainingMs <= 0) {
      fail(new Error("state lease heartbeat lease expired"));
      return;
    }
    expiryTimer = setTimeout(watchExpiry, remainingMs);
  };
  const settleStartup = (trigger: "timeout" | "message") => {
    clearTimeout(startTimer);
    // Readiness precedes notification delivery. A delayed parent must not
    // overwrite ready; callback entry still requires a fresh acknowledgement.
    const observedStatus = Atomics.compareExchange(
      shared,
      state.status,
      state.starting,
      state.lost,
    );
    if (observedStatus === state.ready) {
      if (startupContext) {
        watchExpiry();
      }
      ready.resolve();
    } else {
      // Report the status before our transition, not the lost state it writes.
      const status =
        observedStatus === state.starting
          ? "starting"
          : observedStatus === state.lost
            ? "lost"
            : "closed";
      fail(
        new Error(
          `state lease heartbeat did not become ready (phase=startup, trigger=${trigger}, status=${status}, elapsedMs=${Math.round(performance.now() - startedAt)}, timeoutMs=${startupTimeoutMs})`,
        ),
      );
    }
  };
  const startupTimeoutMs = Math.max(
    1,
    Math.min(LEASE_HEARTBEAT_START_TIMEOUT_MS, params.expiresAt - Date.now()),
  );
  const startTimer = setTimeout(() => settleStartup("timeout"), startupTimeoutMs);
  let worker: Worker;
  try {
    params.retainCleanup?.(lifecycle.cleanup);
    const url = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.stateLeaseHeartbeat);
    // Async startup retains its actor until the worker owns a guarded connection.
    // Legacy startup needs the parent guard through native worker exit instead.
    const coordinatorRetained = lifecycle.retainCoordinator(() =>
      retainedStartup
        ? withStateDatabaseCoordinatorRuntimeDirectory(retainedStartup.coordinatorRuntime, () =>
            retainHeldStateDatabaseCoordinator(databasePath),
          )
        : retainHeldStateDatabaseCoordinator(databasePath),
    );
    if (!retainedStartup) {
      lifecycle.retainHandle(() =>
        acquireStateDatabaseHandleLease({ databasePath, busyTimeoutMs: 0 }),
      );
    }
    startupContext?.admission.assertCurrent();
    worker = lifecycle.start(
      () =>
        new Worker(url, {
          workerData: {
            path: databasePath,
            existingOnly: retainedStartup ? true : params.existingOnly,
            ...(retainedStartup ? { retainedStartup } : {}),
            ...(coordinatorRetained ? { parentCoordinatorRetained: true as const } : {}),
            identity: {
              scope: params.identity.scope,
              key: params.identity.key,
              owner: params.identity.owner,
            },
            leaseMs: params.leaseMs,
            expiresAt: params.expiresAt,
            heartbeatMs: params.heartbeatMs,
            processOwner: params.processOwner,
            shared: shared.buffer,
          } satisfies LeaseHeartbeatWorkerData,
          env: {},
          execArgv: resolveRuntimeWorkerArgv(url).slice(0, -1),
          stdout: true,
          stderr: true,
        }),
    );
  } catch (error) {
    return lifecycle.failStartup(error);
  }
  // Worker stdio uses parent message delivery, which maintenance can block.
  // The heartbeat emits no normal output; drain runtime bootstrap diagnostics.
  worker.stdout.resume();
  worker.stderr.resume();
  worker.once("error", fail);
  worker.once("exit", () => fail(new Error("state lease heartbeat exited")));
  worker.on("message", (reply: LeaseHeartbeatReply | null) => {
    if (reply === null) {
      settleStartup("message");
      return;
    }
    const request = pending.get(reply.id);
    if (!request) {
      return;
    }
    if (reply.ok && (performance.now() >= request.deadline || remainingLeaseMs() <= 0)) {
      fail(new Error("state lease heartbeat is not responsive"));
      return;
    }
    pending.delete(reply.id);
    clearTimeout(request.timer);
    const { deferred } = request;
    if (!reply.ok) {
      const error = new Error(reply.message);
      if (reply.payload) {
        retainOpenClawStateWorkerErrorPayload(error, reply.payload);
      }
      deferred.reject(hydrateOpenClawStateWorkerError(error));
      return;
    }
    try {
      assertRunning();
      deferred.resolve(reply.expiresAt);
    } catch (error) {
      deferred.reject(error);
    }
  });
  const request = async (operation: LeaseHeartbeatRequest["operation"]): Promise<number> => {
    await ready.promise;
    assertRunning();
    const id = ++nextRequestId;
    const deferred = createDeferredCore<number>();
    const awaiting: PendingHeartbeatRequest = {
      deferred,
      deadline: performance.now() + WORKER_RESPONSE_TIMEOUT_MS,
    };
    pending.set(id, awaiting);
    const checkDeadline = () => {
      const remainingMs = Math.min(awaiting.deadline - performance.now(), remainingLeaseMs());
      if (remainingMs <= 0) {
        fail(new Error("state lease heartbeat is not responsive"));
      } else {
        awaiting.timer = setTimeout(checkDeadline, remainingMs);
      }
    };
    checkDeadline();
    try {
      assertRunning();
      worker.postMessage({ id, operation } satisfies LeaseHeartbeatRequest, []);
    } catch (error) {
      pending.delete(id);
      clearTimeout(awaiting.timer);
      deferred.reject(error);
    }
    return deferred.promise;
  };
  return {
    ready: ready.promise,
    assertRunning,
    verify: () => request("verify"),
    renew: () => request("renew"),
    close,
    stop: lifecycle.stop,
    assertResponsive(expiresAt: number) {
      const deadline =
        performance.now() + Math.min(WORKER_RESPONSE_TIMEOUT_MS, expiresAt - Date.now());
      const requestNumber = Atomics.add(shared, state.request, 1n) + 1n;
      worker.postMessage(null, []);
      // Exit/error callbacks may be queued behind a synchronous SQLite phase.
      // Require a fresh acknowledgement, never a cached ready/alive observation.
      while (Atomics.load(shared, state.status) === state.ready) {
        const ack = Atomics.load(shared, state.ack);
        if (ack === requestNumber && Atomics.load(shared, state.status) === state.ready) {
          return;
        }
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) {
          break;
        }
        Atomics.wait(shared, state.ack, ack, remainingMs);
      }
      const error = new Error("state lease heartbeat is not responsive");
      fail(error);
      throw error;
    },
  };
}
