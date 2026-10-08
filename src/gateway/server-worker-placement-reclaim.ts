import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createAgentRunDirectAbortError } from "../agents/run-termination.js";
import { getRuntimeConfig } from "../config/config.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import { withTimeout } from "../infra/fs-safe.js";
import {
  closeSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
  startSessionWorkAdmissionInterruption,
} from "../sessions/session-lifecycle-admission.js";
import type { WorkerPlacementSessionWorkCancellation } from "./server-worker-placement-cancel.js";
import {
  resolveWorkerPlacementSessionStoreTarget,
  resolveWorkerPlacementSessionTarget,
  WorkerDispatchTargetChangedError,
  type WorkerPlacementSessionRuntime,
} from "./server-worker-placement-session-target.js";
import type { WorkerPlacementReclaimBarriers } from "./worker-environments/placement-reclaim-contract.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { matchesWorkerPlacementTarget } from "./worker-environments/placement-target.js";
import type { WorkerPlacementReclaimRequest } from "./worker-environments/service-contract.js";

type WorkerPlacementReclaimBarrierParams = {
  placements: Pick<WorkerSessionPlacementStore, "get" | "getAsync" | "waitForTurnClaimRelease">;
  loadSessionRuntime: () => Promise<WorkerPlacementSessionRuntime>;
  cancelSessionWork: WorkerPlacementSessionWorkCancellation;
  revokeSessionAuthority: (request: { sessionId: string; sessionKeys: readonly string[] }) => void;
};

export function createGatewayWorkerPlacementReclaimBarriers(
  params: WorkerPlacementReclaimBarrierParams,
): WorkerPlacementReclaimBarriers {
  const resolveLifecycleContext = async ({
    sessionId,
    sessionKey,
    agentId,
  }: WorkerPlacementReclaimRequest) => {
    const sessionRuntime = await params.loadSessionRuntime();
    const resolveTarget = () =>
      resolveWorkerPlacementSessionStoreTarget(sessionRuntime, getRuntimeConfig(), {
        sessionKey,
        agentId,
      });
    const target = resolveTarget();
    const lifecycleIdentities = [sessionKey, target.canonicalKey, ...target.storeKeys, sessionId];
    const cancelAndDrain = async (
      closeWorkAdmissions: (reason: Error) => void,
      assertCurrent: () => void,
      assertCancellationCurrent = assertCurrent,
      pendingSettlement?: Promise<unknown>,
    ) => {
      const reason = createAgentRunDirectAbortError();
      assertCurrent();
      closeWorkAdmissions(reason);
      let released: Promise<void> | undefined;
      let interruptionStarted = false;
      let interruptionError: Error | undefined;
      const interrupt = () => {
        if (interruptionStarted) {
          return;
        }
        interruptionStarted = true;
        try {
          assertCurrent();
          released = startSessionWorkAdmissionInterruption({
            reason,
            scope: target.storePath,
            identities: lifecycleIdentities,
          }).released;
        } catch (error) {
          // The synchronous abort producer must still persist its terminal/partial outcome.
          interruptionError = toErrorObject(error, "Session work interruption failed");
        }
      };
      const settled = pendingSettlement?.then(
        () => undefined,
        () => undefined,
      );
      try {
        await params.cancelSessionWork({
          sessionId,
          sessionKeys: lifecycleIdentities,
          agentId,
          assertCurrent: assertCancellationCurrent,
          // A queued dispatch can coexist with local chat before any placement exists.
          // Interrupt only after canonical abort snapshots partials and retires approvals.
          ...(pendingSettlement ? { onCancellationStarted: interrupt } : {}),
        });
        interrupt();
        // Caller timeouts do not settle provider work. Keep this exact operation outside
        // the native-turn deadline, then bound the remaining admission/turn drains.
        await settled;
        if (interruptionError !== undefined) {
          throw interruptionError;
        }
        assertCurrent();
        await withTimeout(
          released!,
          SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
          "session work admission drain",
        );
      } catch (error) {
        if (interruptionStarted) {
          await settled;
        }
        throw error;
      }
      await params.placements.waitForTurnClaimRelease(sessionId, {
        timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      });
      await runExclusiveSessionStoreWrite(target.storePath, async () => {}, { reentrant: true });
    };

    return { sessionRuntime, target, resolveTarget, lifecycleIdentities, cancelAndDrain };
  };

  const runReclaimPreparation: WorkerPlacementReclaimBarriers["runReclaimPreparation"] = async ({
    sessionId,
    sessionKey,
    agentId,
    authorize,
    beforeDrain,
    pendingOperations,
    run,
  }) => {
    const { sessionRuntime, target, resolveTarget, lifecycleIdentities, cancelAndDrain } =
      await resolveLifecycleContext({ sessionId, sessionKey, agentId });
    const entry = sessionRuntime.resolveCanonicalSessionEntryFromStoreKeys(
      target.store,
      target.storeKeys,
    );
    const revision = entry?.lifecycleRevision ?? null;
    const assertTargetCurrent = () => {
      const current = resolveTarget();
      const currentEntry = sessionRuntime.resolveCanonicalSessionEntryFromStoreKeys(
        current.store,
        current.storeKeys,
      );
      if (
        current.storePath !== target.storePath ||
        current.canonicalKey !== target.canonicalKey ||
        current.agentId !== target.agentId ||
        currentEntry?.sessionId !== sessionId ||
        (currentEntry.lifecycleRevision ?? null) !== revision
      ) {
        throw new WorkerDispatchTargetChangedError(
          `Session ${sessionKey} changed before cloud worker stop. Retry.`,
        );
      }
    };
    const assertCurrent = Object.assign(
      () => {
        authorize?.();
        assertTargetCurrent();
      },
      {
        // Transport waits keep caller custody; both write grants reread the session target.
        assertWorkerLifetime: () => (authorize?.assertWorkerLifetime ?? authorize)?.(),
        assertWorkerGrant: () => {
          (authorize?.assertWorkerGrant ?? authorize)?.();
          assertTargetCurrent();
        },
      },
    );
    const placement = await params.placements.getAsync(sessionId);
    assertCurrent();
    beforeDrain?.();
    const pending = pendingOperations?.isCurrent() ? pendingOperations : undefined;
    const dispatch = pending?.hasPendingDispatch() === true;
    if (
      !dispatch &&
      (!placement || placement.state === "local" || placement.state === "reclaimed")
    ) {
      // A predecessor Stop is an ordering dependency, not authority to cancel local chat.
      await pending?.settled;
      assertCurrent();
      return await run(assertCurrent);
    }
    // This lease blocks ingress without a mutex: predecessors must still be able to
    // settle their lifecycle work before Stop enters session cleanup.
    const release = closeSessionWorkAdmissions({
      scope: target.storePath,
      identities: lifecycleIdentities,
      reason: createAgentRunDirectAbortError(),
    });
    try {
      const cancelRunningWork =
        placement?.state === "active" ||
        placement?.state === "draining" ||
        placement?.state === "failed";
      if (dispatch || cancelRunningWork) {
        await cancelAndDrain(
          () => {},
          assertCurrent,
          () => {
            assertCurrent();
            const current = params.placements.get(sessionId);
            const captured = pending?.currentPlacement();
            // A predecessor can retain an older phase after its captured dispatch completes.
            // Keep the newest recorded fact within the lifecycle just revalidated above.
            const expected =
              captured && (!placement || captured.generation > placement.generation)
                ? captured
                : placement;
            if ((expected || pending) && !matchesWorkerPlacementTarget(current, expected)) {
              throw new WorkerDispatchTargetChangedError(
                `Session ${sessionKey} cloud worker changed before cancellation. Retry.`,
              );
            }
          },
          pending?.settled,
        );
      } else {
        await pending?.settled;
      }
      assertCurrent();
      return await run(assertCurrent);
    } finally {
      release();
    }
  };

  const runReclaimBarrier: WorkerPlacementReclaimBarriers["runReclaimBarrier"] = async ({
    sessionId,
    sessionKey,
    agentId,
    authorize,
    beforeDrain,
    begin,
    reclaim,
  }) => {
    const { sessionRuntime, target, lifecycleIdentities, cancelAndDrain } =
      await resolveLifecycleContext({
        sessionId,
        sessionKey,
        agentId,
      });
    let assertBindingCurrent: (() => void) | undefined;
    return await runExclusiveSessionLifecycleMutation("placement-reclaim", {
      scope: target.storePath,
      identities: lifecycleIdentities,
      prepare: async (lifecycle) => {
        beforeDrain?.();
        const resolved = await resolveWorkerPlacementSessionTarget({
          sessionRuntime,
          config: getRuntimeConfig(),
          sessionId,
          sessionKey,
          agentId,
          expectedTarget: target,
          errorMessage: `Session ${sessionKey} changed before cloud worker stop. Retry.`,
        });
        const placement = await params.placements.getAsync(sessionId);
        authorize?.();
        resolved.assertBindingCurrent(getRuntimeConfig());
        if (
          placement?.state !== "active" &&
          placement?.state !== "draining" &&
          placement?.state !== "reclaimed"
        ) {
          throw new Error(
            `Session ${sessionKey} cannot stop cloud worker from placement ${placement?.state ?? "missing"}`,
          );
        }
        assertBindingCurrent = () => {
          authorize?.();
          resolved.assertBindingCurrent(getRuntimeConfig());
        };
        await cancelAndDrain(lifecycle.closeWorkAdmissions, assertBindingCurrent);
      },
      run: async () => {
        if (!assertBindingCurrent) {
          throw new Error(`Session ${sessionKey} cloud worker stop barrier did not prepare`);
        }
        assertBindingCurrent();
        const resolved = await resolveWorkerPlacementSessionTarget({
          sessionRuntime,
          config: getRuntimeConfig(),
          sessionId,
          sessionKey,
          agentId,
          expectedTarget: target,
          errorMessage: `Session ${sessionKey} changed before cloud worker stop. Retry.`,
        });
        // Sharing mutations use this lifecycle fence too. Reauthorize after every wait and
        // immediately before drain so revoked callers cannot commit stale placement authority.
        assertBindingCurrent();
        // Eligibility ends at this operation's drain, unlike caller authority during teardown.
        beforeDrain?.();
        resolved.assertCurrent(getRuntimeConfig());
        const assertDrainCurrent = () => {
          assertBindingCurrent?.();
          resolved.assertCurrent(getRuntimeConfig());
        };
        const placement = await begin(assertDrainCurrent);
        assertDrainCurrent();
        const reclaimedPlacement = await reclaim(resolved.workspace, placement, assertDrainCurrent);
        params.revokeSessionAuthority({ sessionId, sessionKeys: lifecycleIdentities });
        return reclaimedPlacement;
      },
    });
  };

  const runFailedReclaimBarrier: WorkerPlacementReclaimBarriers["runFailedReclaimBarrier"] =
    async ({ sessionId, sessionKey, agentId, authorize, reclaim }) => {
      const { sessionRuntime, target, resolveTarget, lifecycleIdentities, cancelAndDrain } =
        await resolveLifecycleContext({
          sessionId,
          sessionKey,
          agentId,
        });
      const assertCurrent = () => {
        const currentTarget = resolveTarget();
        const currentEntry = sessionRuntime.resolveCanonicalSessionEntryFromStoreKeys(
          currentTarget.store,
          currentTarget.storeKeys,
        );
        if (
          currentTarget.storePath !== target.storePath ||
          currentTarget.canonicalKey !== target.canonicalKey ||
          currentTarget.agentId !== target.agentId ||
          currentEntry?.sessionId !== sessionId
        ) {
          throw new WorkerDispatchTargetChangedError(
            `Session ${sessionKey} changed before failed cloud worker cleanup. Retry.`,
          );
        }
        // Failed teardown is still a session mutation: reauthorize inside the shared lifecycle
        // fence before provider cleanup or the failed-to-local transition becomes durable.
        authorize?.();
      };
      return await runExclusiveSessionLifecycleMutation("placement-failed-reclaim", {
        scope: target.storePath,
        identities: lifecycleIdentities,
        prepare: async (lifecycle) => {
          // A preceding failed cleanup may already have returned this placement to local.
          // Its idempotent result must not cancel work admitted after that completed Stop.
          const placement = await params.placements.getAsync(sessionId);
          assertCurrent();
          if (placement?.state === "failed") {
            await cancelAndDrain(lifecycle.closeWorkAdmissions, assertCurrent);
          }
        },
        run: async () => {
          assertCurrent();
          return await reclaim(authorize);
        },
      });
    };

  return { runReclaimPreparation, runReclaimBarrier, runFailedReclaimBarrier };
}
