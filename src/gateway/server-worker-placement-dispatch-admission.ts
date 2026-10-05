import { getRuntimeConfig } from "../config/config.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import {
  resolveWorkerPlacementSessionStoreTarget,
  type WorkerPlacementSessionRuntime,
} from "./server-worker-placement-session-target.js";
import { recordWorkerPlacementStage } from "./worker-environments/placement-diagnostics.js";
import {
  WorkerPlacementAdmissionTargetError,
  type WorkerPlacementDispatchAdmission,
} from "./worker-environments/service-contract.js";

export function createGatewayWorkerDispatchAdmission(
  loadSessionRuntime: () => Promise<WorkerPlacementSessionRuntime>,
): WorkerPlacementDispatchAdmission {
  return async (request, run, authorize, callerSignal) => {
    callerSignal?.throwIfAborted();
    const runtime = await loadSessionRuntime();
    const resolve = () =>
      resolveWorkerPlacementSessionStoreTarget(runtime, getRuntimeConfig(), request);
    const target = resolve();
    const entry = runtime.resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys);
    const revision = entry?.lifecycleRevision ?? null;
    const controller = new AbortController();
    let preparationPhase: "dispatch_admission" | "dispatch" | "background" = "dispatch_admission";
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    const admission = await beginSessionWorkAdmission({
      scope: target.storePath,
      identities: [request.sessionKey, target.canonicalKey, ...target.storeKeys, request.sessionId],
      onInterrupt: (reason) => {
        if (!controller.signal.aborted) {
          recordWorkerPlacementStage(request.sessionId, "repository_preparation_interrupted", {
            cancellationOwner: "session_lifecycle",
            preparationPhase,
            error: reason,
          });
        }
        controller.abort(reason);
      },
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
    const background = new Set<Promise<void>>();
    const assertRepositoryCleanupCurrent = () => {
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
          "Repository preparation session lifecycle changed",
        );
      }
    };
    const assertRepositoryPreparationCurrent = () => {
      controller.signal.throwIfAborted();
      if (!admission.isActive()) {
        throw new Error("Repository preparation admission closed");
      }
      assertRepositoryCleanupCurrent();
    };
    try {
      // Reserve before the placement queue, and exclude this owner from its own local barrier.
      // Release only after dispatch's canonical failure cleanup has settled the provider child.
      preparationPhase = "dispatch";
      return await admission.run(() =>
        run(signal, {
          signal: controller.signal,
          assertCurrent: assertRepositoryPreparationCurrent,
          assertCleanupCurrent: assertRepositoryCleanupCurrent,
          track: (operation) => {
            background.add(operation);
            void operation.catch(() => undefined);
          },
        }),
      );
    } finally {
      if (background.size === 0) {
        admission.release();
      } else {
        preparationPhase = "background";
        void Promise.allSettled(background).then(() => admission.release());
      }
    }
  };
}
