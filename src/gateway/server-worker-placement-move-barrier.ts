import { clearSessionLifecycleQueues } from "../auto-reply/reply/queue/cleanup.js";
import { getRuntimeConfig } from "../config/config.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
  startSessionWorkAdmissionInterruption,
} from "../sessions/session-lifecycle-admission.js";
import {
  resolveWorkerPlacementSessionTarget,
  type WorkerPlacementSessionRuntime,
} from "./server-worker-placement-session-target.js";
import type { WorkerPlacementMoveBarrier } from "./worker-environments/placement-move-service.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

export function createGatewayWorkerPlacementMoveBarrier(params: {
  placements: Pick<WorkerSessionPlacementStore, "waitForTurnClaimRelease">;
  awaitTurnClaimRelease: (sessionId: string, wait: () => Promise<void>) => Promise<void>;
  loadSessionRuntime: () => Promise<WorkerPlacementSessionRuntime>;
  revokeSessionAuthority: (request: { sessionId: string; sessionKeys: readonly string[] }) => void;
  persistAbandonedPartial?: (request: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
    runId: string;
  }) => Promise<void>;
}): WorkerPlacementMoveBarrier {
  return async ({
    sessionId,
    sessionKey,
    agentId,
    sourceDisposition,
    authorize,
    signal,
    begin,
  }) => {
    const sessionRuntime = await params.loadSessionRuntime();
    const target = sessionRuntime.resolveGatewaySessionStoreTargetWithStore({
      cfg: getRuntimeConfig(),
      key: sessionKey,
      agentId,
      preserveQualifiedAddress: true,
      clone: false,
      exactRead: true,
    });
    const lifecycleIdentities = [sessionKey, target.canonicalKey, ...target.storeKeys, sessionId];
    let begun: Awaited<ReturnType<typeof begin>> | undefined;
    return await runExclusiveSessionLifecycleMutation("placement-move", {
      scope: target.storePath,
      identities: lifecycleIdentities,
      signal,
      prepare: async () => {
        const resolved = await resolveWorkerPlacementSessionTarget({
          sessionRuntime,
          config: getRuntimeConfig(),
          sessionId,
          sessionKey,
          agentId,
          expectedTarget: target,
          errorMessage: `Session ${sessionKey} changed before placement move. Retry.`,
        });
        resolved.assertCurrent(getRuntimeConfig());
        authorize?.();
        begun = await begin(async (runId) => {
          if (params.persistAbandonedPartial) {
            // Persist before a new durable drain closes the exact worker run;
            // joined decisions never invoke this mint-only callback.
            await params.persistAbandonedPartial({ sessionId, sessionKey, agentId, runId });
            authorize?.();
          }
        });
        clearSessionLifecycleQueues({
          keys: lifecycleIdentities,
          agentId: resolved.target.agentId,
          sessionKey: resolved.target.canonicalKey,
          sessionId,
          // The move committed; settling its source queues must survive authority changes.
          assertCurrent: () => {},
        });
        params.revokeSessionAuthority({ sessionId, sessionKeys: lifecycleIdentities });
        if (sourceDisposition === "abandon") {
          // Explicit abandonment revokes the old owner locally; its unreachable
          // transport acknowledgement cannot delay the exact force-abandon owner.
          startSessionWorkAdmissionInterruption({
            scope: target.storePath,
            identities: lifecycleIdentities,
          });
          return;
        }
        await params.awaitTurnClaimRelease(sessionId, async () => {
          const released = await interruptSessionWorkAdmissions({
            scope: target.storePath,
            identities: lifecycleIdentities,
            timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
          });
          if (!released) {
            throw new Error(`Session ${sessionKey} is still active; placement move interrupted`);
          }
          await params.placements.waitForTurnClaimRelease(sessionId, {
            timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
            signal,
          });
        });
        await runExclusiveSessionStoreWrite(target.storePath, async () => {}, {
          reentrant: true,
        });
      },
      run: async () => {
        if (!begun) {
          throw new Error(`Session ${sessionKey} placement move barrier did not start`);
        }
        return begun;
      },
    });
  };
}
