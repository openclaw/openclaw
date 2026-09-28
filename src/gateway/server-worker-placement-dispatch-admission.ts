import { getRuntimeConfig } from "../config/config.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import {
  beginSessionWorkAdmission,
  closeSessionWorkAdmissions,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
  startSessionWorkAdmissionInterruption,
  waitForSessionWorkAdmissionRelease,
} from "../sessions/session-lifecycle-admission.js";
import type { WorkerPlacementSessionRuntime } from "./server-worker-placement-reclaim.js";
import type { WorkerPlacementDrain } from "./worker-environments/placement-dispatch-coordinator.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import {
  WorkerPlacementAdmissionTargetError,
  type WorkerPlacementDispatchAdmission,
} from "./worker-environments/service-contract.js";

export function createGatewayWorkerPlacementDrain(
  placements: Pick<WorkerSessionPlacementStore, "waitForTurnClaimRelease">,
  loadSessionRuntime: () => Promise<WorkerPlacementSessionRuntime>,
): WorkerPlacementDrain {
  return async ({ sessionId, sessionKey, agentId, action, authorize, signal }) => {
    signal?.throwIfAborted();
    const runtime = await racePromiseWithAbortSignal(loadSessionRuntime(), signal);
    const target = runtime.resolveGatewaySessionStoreTargetWithStore({
      cfg: getRuntimeConfig(),
      key: sessionKey,
      agentId,
      clone: false,
      exactRead: true,
    });
    const lifecycle = {
      scope: target.storePath,
      identities: [sessionKey, target.canonicalKey, ...target.storeKeys, sessionId],
    };
    signal?.throwIfAborted();
    authorize?.();
    // Fence ingress without a mutex so targeted result recovery can still release the claim.
    const release = closeSessionWorkAdmissions({
      ...lifecycle,
      reason: new Error("Session work admission interrupted"),
    });
    try {
      const { released } = startSessionWorkAdmissionInterruption(lifecycle);
      if (
        !(await waitForSessionWorkAdmissionRelease(
          racePromiseWithAbortSignal(released, signal),
          SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
        ))
      ) {
        throw new Error(
          `Session ${sessionKey} is still active; ${action === "move" ? "placement move interrupted" : "dispatch stopped"}`,
        );
      }
      signal?.throwIfAborted();
      await placements.waitForTurnClaimRelease(sessionId, {
        timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
        signal,
      });
      signal?.throwIfAborted();
      return { release };
    } catch (error) {
      release();
      throw error;
    }
  };
}

export function createGatewayWorkerDispatchAdmission(
  loadSessionRuntime: () => Promise<WorkerPlacementSessionRuntime>,
): WorkerPlacementDispatchAdmission {
  return async (request, run, authorize, callerSignal) => {
    callerSignal?.throwIfAborted();
    const runtime = await loadSessionRuntime();
    const resolve = () =>
      runtime.resolveGatewaySessionStoreTargetWithStore({
        cfg: getRuntimeConfig(),
        key: request.sessionKey,
        agentId: request.agentId,
        clone: false,
        exactRead: true,
      });
    const target = resolve();
    const entry = runtime.resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys);
    const revision = entry?.lifecycleRevision ?? null;
    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    const admission = await beginSessionWorkAdmission({
      scope: target.storePath,
      identities: [request.sessionKey, target.canonicalKey, ...target.storeKeys, request.sessionId],
      onInterrupt: (reason) => controller.abort(reason),
      signal,
      assertAllowed: () => {
        authorize?.();
        signal.throwIfAborted();
        const current = resolve();
        const currentEntry = runtime.resolveCanonicalSessionEntryFromStoreKeys(
          current.store,
          current.storeKeys,
        );
        if (
          current.storePath !== target.storePath ||
          current.canonicalKey !== target.canonicalKey ||
          current.agentId !== target.agentId ||
          currentEntry?.sessionId !== request.sessionId ||
          (currentEntry.lifecycleRevision ?? null) !== revision ||
          currentEntry.archivedAt !== undefined
        ) {
          throw new WorkerPlacementAdmissionTargetError(
            `Session ${request.sessionKey} changed before cloud worker dispatch. Retry.`,
          );
        }
      },
    });
    try {
      // Reserve before the placement queue, and exclude this owner from its own local barrier.
      // Release only after dispatch's canonical failure cleanup has settled the provider child.
      return await admission.run(() => run(signal));
    } finally {
      admission.release();
    }
  };
}
