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
  resolveWorkerPlacementSessionStoreTarget,
  resolveWorkerPlacementSessionTarget,
  type WorkerPlacementSessionRuntime,
} from "./server-worker-placement-session-target.js";
import type { WorkerPlacementMoveBarrier } from "./worker-environments/placement-move-service.js";
import type { WorkerSessionPlacementIdentity } from "./worker-environments/placement-record.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

export type WorkerPlacementHandoffParams = {
  placements: Pick<WorkerSessionPlacementStore, "waitForTurnClaimRelease">;
  awaitTurnClaimRelease: (sessionId: string, wait: () => Promise<void>) => Promise<void>;
  revokeSessionAuthority: (request: { sessionId: string; sessionKeys: readonly string[] }) => void;
};

export async function runWorkerPlacementHandoff<T>(
  params: WorkerPlacementHandoffParams,
  request: WorkerSessionPlacementIdentity & {
    action: "dispatch" | "move";
    requiredProfile?: string;
    sourceDisposition?: "reconcile" | "abandon";
    signal?: AbortSignal;
  },
  sessionRuntime: WorkerPlacementSessionRuntime,
  begin: (resolved: Awaited<ReturnType<typeof resolveWorkerPlacementSessionTarget>>) => Promise<T>,
): Promise<T> {
  const { sessionId, sessionKey, agentId, action, signal } = request;
  const target = resolveWorkerPlacementSessionStoreTarget(
    sessionRuntime,
    getRuntimeConfig(),
    request,
  );
  const lifecycleIdentities = [sessionKey, target.canonicalKey, ...target.storeKeys, sessionId];
  let begun: T;
  return await runExclusiveSessionLifecycleMutation(`placement-${action}`, {
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
        errorMessage: `Session ${sessionKey} changed before ${action === "dispatch" ? "cloud worker dispatch" : "placement move"}. Retry.`,
      });
      resolved.assertCurrent(getRuntimeConfig());
      begun = await begin(resolved);
      if (action === "dispatch" && request.requiredProfile) {
        // Initial required placement belongs to this held input; there is no local
        // turn to revoke, and clearing its queues would discard the first message.
        return;
      }
      clearSessionLifecycleQueues({
        keys: lifecycleIdentities,
        agentId: resolved.target.agentId,
        sessionKey: resolved.target.canonicalKey,
        sessionId,
        // Placement committed; settling its source queues must survive authority changes.
        assertCurrent: () => {},
      });
      params.revokeSessionAuthority({ sessionId, sessionKeys: lifecycleIdentities });
      if (request.sourceDisposition === "abandon") {
        // Explicit abandonment cannot wait for an unreachable source's acknowledgement.
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
          throw new Error(
            `Session ${sessionKey} is still active; ${action === "dispatch" ? "dispatch stopped" : "placement move interrupted"}`,
          );
        }
        await params.placements.waitForTurnClaimRelease(sessionId, {
          timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
          signal,
        });
      });
      await runExclusiveSessionStoreWrite(target.storePath, async () => {}, { reentrant: true });
    },
    run: async () => begun,
  });
}

export function createGatewayWorkerPlacementMoveBarrier(
  params: WorkerPlacementHandoffParams & {
    loadSessionRuntime: () => Promise<WorkerPlacementSessionRuntime>;
    persistAbandonedPartial?: (
      request: WorkerSessionPlacementIdentity & { runId: string },
    ) => Promise<void>;
  },
): WorkerPlacementMoveBarrier {
  return async (request) =>
    runWorkerPlacementHandoff(
      params,
      { ...request, action: "move" },
      await params.loadSessionRuntime(),
      async () => {
        request.authorize?.();
        return await request.begin(async (runId) => {
          if (params.persistAbandonedPartial) {
            // Persist before a new durable drain closes the exact worker run;
            // joined decisions never invoke this mint-only callback.
            const { sessionId, sessionKey, agentId } = request;
            await params.persistAbandonedPartial({ sessionId, sessionKey, agentId, runId });
            request.authorize?.();
          }
        });
      },
    );
}
