import type { Worker } from "node:worker_threads";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  acquireStateDatabaseHandleLease,
  retainHeldStateDatabaseCoordinator,
} from "../infra/state-database-coordinator.js";
import { createCpuTrackedWorker } from "../infra/worker-cpu.js";
import { runInDetachedAsyncContext } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  leaseHeartbeatState as state,
  LEASE_HEARTBEAT_START_TIMEOUT_MS,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";

const WORKER_RESPONSE_TIMEOUT_MS = 1_000;

export function startOpenClawStateLeaseHeartbeat(
  params: Omit<LeaseHeartbeatWorkerData, "shared" | "parentCoordinatorRetained"> & {
    expiresAt: number;
    onLost: (error: Error) => void;
    /** The live host renews until the worker can take over; never revives an expired owner. */
    renewDuringStartup?: () => number;
  },
) {
  const startedAt = performance.now();
  const shared = new BigInt64Array(new SharedArrayBuffer(4 * BigInt64Array.BYTES_PER_ELEMENT));
  Atomics.store(shared, state.expiresAt, BigInt(params.expiresAt));
  const url = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.stateLeaseHeartbeat);
  const workerArgv = resolveRuntimeWorkerArgv(url);
  // Source aliases belong to the parent-selected tsconfig, not an unrelated cwd.
  // Keep the lease worker isolated from every other ambient environment setting.
  const sourceTsconfig = workerArgv.length > 1 ? process.env.TSX_TSCONFIG_PATH : undefined;
  // Retain a parent-owned physical lease through native worker teardown. A forced
  // Worker.terminate() need not run JS cleanup; the exit event does attest that
  // native source handles have settled before this last guard is released.
  const coordinator = retainHeldStateDatabaseCoordinator(params.path);
  let handle: ReturnType<typeof acquireStateDatabaseHandleLease>;
  try {
    handle = acquireStateDatabaseHandleLease({ databasePath: params.path, busyTimeoutMs: 0 });
  } catch (error) {
    coordinator?.release();
    throw error;
  }
  const release = () => {
    try {
      handle.release();
    } finally {
      coordinator?.release();
    }
  };
  let worker: Worker;
  try {
    // Native stdio ports can outlive termination and retain their creation context.
    worker = runInDetachedAsyncContext(() =>
      createCpuTrackedWorker(url, {
        workerData: {
          path: params.path,
          existingOnly: params.existingOnly,
          ...(coordinator ? { parentCoordinatorRetained: true as const } : {}),
          identity: {
            scope: params.identity.scope,
            key: params.identity.key,
            owner: params.identity.owner,
          },
          leaseMs: params.leaseMs,
          heartbeatMs: params.heartbeatMs,
          processOwner: params.processOwner,
          shared: shared.buffer,
        } satisfies LeaseHeartbeatWorkerData,
        env: sourceTsconfig ? { TSX_TSCONFIG_PATH: sourceTsconfig } : {},
        execArgv: workerArgv.slice(0, -1),
        stdout: true,
        stderr: true,
      }),
    );
  } catch (error) {
    release();
    throw error;
  }
  let handleReleaseError: Error | undefined;
  worker.once("exit", () => {
    try {
      release();
    } catch (error) {
      handleReleaseError = new Error("state lease heartbeat handle release failed", {
        cause: error,
      });
      params.onLost(handleReleaseError);
    }
  });
  // Worker stdio uses parent message delivery, which maintenance can block.
  // The heartbeat emits no normal output; drain runtime bootstrap diagnostics.
  worker.stdout.resume();
  worker.stderr.resume();
  const ready = createDeferredCore();
  let startupRenewal: ReturnType<typeof setTimeout> | undefined;
  const clearStartupTimers = () => {
    clearTimeout(startTimer);
    clearTimeout(startupRenewal);
    startupRenewal = undefined;
  };
  const fail = (error: Error) => {
    if (Atomics.load(shared, state.status) === state.closed) {
      return;
    }
    Atomics.store(shared, state.status, state.lost);
    Atomics.notify(shared, state.ack);
    clearStartupTimers();
    ready.reject(error);
    params.onLost(error);
  };
  const settleStartup = (trigger: "timeout" | "message") => {
    clearTimeout(startTimer);
    if (trigger === "timeout" && Atomics.load(shared, state.status) === state.starting) {
      const elapsedMs = performance.now() - startedAt;
      const remainingMs = Math.min(
        LEASE_HEARTBEAT_START_TIMEOUT_MS - elapsedMs,
        Number(Atomics.load(shared, state.expiresAt)) - Date.now(),
      );
      if (remainingMs > 0) {
        // A committed host renewal changes the lease bound, never the startup cap.
        startupTimeoutMs = Math.round(elapsedMs + remainingMs);
        startTimer = setTimeout(() => settleStartup("timeout"), remainingMs);
        return;
      }
    }
    clearStartupTimers();
    // Readiness precedes notification delivery. A delayed parent must not
    // overwrite ready; callback entry still requires a fresh acknowledgement.
    const observedStatus = Atomics.compareExchange(
      shared,
      state.status,
      state.starting,
      state.lost,
    );
    if (observedStatus === state.ready) {
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
  let startupTimeoutMs = Math.max(
    1,
    Math.min(LEASE_HEARTBEAT_START_TIMEOUT_MS, params.expiresAt - Date.now()),
  );
  let startTimer = setTimeout(() => settleStartup("timeout"), startupTimeoutMs);
  const renewDuringStartup = params.renewDuringStartup;
  const renewStartup = () => {
    startupRenewal = undefined;
    if (Atomics.load(shared, state.status) !== state.starting || !renewDuringStartup) {
      return;
    }
    try {
      const expiresAt = renewDuringStartup();
      if (Atomics.load(shared, state.status) !== state.starting) {
        return;
      }
      Atomics.store(shared, state.expiresAt, BigInt(expiresAt));
      startupRenewal = setTimeout(renewStartup, params.heartbeatMs);
    } catch (error) {
      fail(
        error instanceof Error
          ? error
          : new Error("state lease startup renewal failed", { cause: error }),
      );
    }
  };
  if (renewDuringStartup) {
    startupRenewal = setTimeout(renewStartup, params.heartbeatMs);
  }
  worker.once("error", fail);
  worker.once("exit", () => fail(new Error("state lease heartbeat exited")));
  worker.once("message", () => settleStartup("message"));
  let stopping: Promise<number> | undefined;
  const close = () => {
    Atomics.store(shared, state.status, state.closed);
    Atomics.notify(shared, state.ack);
    clearStartupTimers();
    ready.reject(new Error("state lease heartbeat closed"));
  };
  return {
    ready: ready.promise,
    close,
    stop() {
      close();
      return (stopping ??= worker.terminate().then((code) => {
        if (handleReleaseError) {
          throw handleReleaseError;
        }
        return code;
      }));
    },
    assertResponsive(expiresAt: number) {
      const deadline =
        performance.now() + Math.min(WORKER_RESPONSE_TIMEOUT_MS, expiresAt - Date.now());
      const request = Atomics.add(shared, state.request, 1n) + 1n;
      worker.postMessage(null, []);
      // Exit/error callbacks may be queued behind a synchronous SQLite phase.
      // Require a fresh acknowledgement, never a cached ready/alive observation.
      while (Atomics.load(shared, state.status) === state.ready) {
        const ack = Atomics.load(shared, state.ack);
        if (ack === request && Atomics.load(shared, state.status) === state.ready) {
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
