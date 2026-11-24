import { clearSessionQueues } from "../auto-reply/reply/queue/cleanup.js";
import { getRuntimeConfig } from "../config/config.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import {
  captureSessionTarget,
  interruptSessionControllerEffects,
  isCompetingSessionControllerWorkActive,
  runSessionMutation,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
  startSessionControllerInterruption,
} from "../sessions/session-controller.lifecycle.js";
import { captureSessionControllerStop } from "../sessions/session-controller.stop.js";
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
  const target = await resolveWorkerPlacementSessionStoreTarget(
    sessionRuntime,
    getRuntimeConfig(),
    request,
  );
  const lifecycleIdentities = [sessionKey, target.canonicalKey, ...target.storeKeys, sessionId];
  const controllerTarget = captureSessionTarget({
    storeScope: target.storePath,
    sessionKey: target.canonicalKey,
    aliases: lifecycleIdentities,
    agentId: target.agentId,
    incarnation: sessionId,
  });
  let begun: T;
  return await runSessionMutation({
    target: controllerTarget,
    signal,
    prepare: async () => {
      using resolved = await resolveWorkerPlacementSessionTarget({
        sessionRuntime,
        config: getRuntimeConfig(),
        sessionId,
        sessionKey,
        agentId,
        expectedTarget: target,
        errorMessage: `Session ${sessionKey} changed before ${action === "dispatch" ? "cloud worker dispatch" : "placement move"}. Retry.`,
      });
      resolved.assertCurrent(getRuntimeConfig());
      if (
        action === "dispatch" &&
        isCompetingSessionControllerWorkActive(
          target.storePath,
          lifecycleIdentities,
          target.agentId,
        )
      ) {
        throw new Error(
          `Session ${sessionKey} is busy with active work; wait for the turn to finish and retry dispatch.`,
        );
      }
      const queuedInputs = captureSessionControllerStop({
        targets: [controllerTarget],
        includeActive: false,
      }).queuedInputs;
      begun = await begin(resolved);
      if (action === "dispatch" && request.requiredProfile) {
        // Initial required placement belongs to this held input; there is no local
        // turn to revoke, and clearing its queues would discard the first message.
        return;
      }
      clearSessionQueues(lifecycleIdentities, controllerTarget, queuedInputs);
      params.revokeSessionAuthority({ sessionId, sessionKeys: lifecycleIdentities });
      if (request.sourceDisposition === "abandon") {
        // Explicit abandonment cannot wait for an unreachable source's acknowledgement.
        startSessionControllerInterruption({ target: controllerTarget });
        return;
      }
      const released = await interruptSessionControllerEffects({
        target: controllerTarget,
        timeoutMs: SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
      });
      if (!released) {
        throw new Error(
          `Session ${sessionKey} is still active; ${action === "dispatch" ? "dispatch stopped" : "placement move interrupted"}`,
        );
      }
      await params.placements.waitForTurnClaimRelease(sessionId, {
        timeoutMs: SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
        signal,
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
      async ({ workspace }) => {
        if (workspace.kind === "device-folder") {
          throw new Error(
            "Device folders cannot move or Continue on Gateway; reconnect the original device or start a new session.",
          );
        }
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
