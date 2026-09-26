import { clearSessionQueues } from "../auto-reply/reply/queue/cleanup.js";
import { getRuntimeConfig } from "../config/config.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../sessions/session-lifecycle-admission.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  loadWorkerPlacementSessionRuntimeModule,
  resolveWorkerPlacementSessionTarget,
  WorkerDispatchTargetChangedError,
} from "./server-worker-placement-session-target.js";
import type { GatewayWorkerPlacementRuntimeParams } from "./server-worker-placement-startup.js";
import type { createWorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";

const loadWorkerWorkspacePreflight = createLazyRuntimeModule(async () => {
  const { preflightWorkerWorkspace } =
    await import("./worker-environments/workspace-sync-preflight.js");
  return preflightWorkerWorkspace;
});

/** Serialize local-to-worker ownership, retaining the held first input for required placement. */
export function createGatewayWorkerPlacementLocalBarrier(
  params: Pick<GatewayWorkerPlacementRuntimeParams, "placements" | "revokeSessionAuthority">,
): NonNullable<Parameters<typeof createWorkerPlacementDispatchService>[0]["runLocalBarrier"]> {
  return async ({
    sessionId,
    sessionKey,
    agentId,
    executionMode,
    requiredProfile,
    authorize,
    signal,
    startDispatch,
  }) => {
    const sessionRuntime = await loadWorkerPlacementSessionRuntimeModule();
    const {
      resolveWorkerPlacementExecutionMode,
      resolveGatewaySessionStoreTargetWithStore,
      resolveWorkerPlacementSessionRuntime,
    } = sessionRuntime;
    const target = resolveGatewaySessionStoreTargetWithStore({
      cfg: getRuntimeConfig(),
      key: sessionKey,
      agentId,
      clone: false,
      exactRead: true,
    });
    const lifecycleIdentities = [sessionKey, target.canonicalKey, ...target.storeKeys, sessionId];
    let placement: Awaited<ReturnType<typeof startDispatch>> | undefined;
    await runExclusiveSessionLifecycleMutation({
      scope: target.storePath,
      identities: lifecycleIdentities,
      signal,
      prepare: async () => {
        const {
          config: currentConfig,
          target: currentTarget,
          entry: currentEntry,
          workspace,
        } = resolveWorkerPlacementSessionTarget({
          sessionRuntime,
          config: getRuntimeConfig(),
          sessionId,
          sessionKey,
          agentId,
          expectedTarget: target,
          errorMessage: `Session ${sessionKey} changed before cloud worker dispatch. Retry.`,
        });
        if (currentEntry.archivedAt !== undefined) {
          throw new WorkerDispatchTargetChangedError(
            `Session ${sessionKey} was archived before cloud worker dispatch. Retry.`,
          );
        }
        const currentRuntime = resolveWorkerPlacementSessionRuntime({
          cfg: currentConfig,
          entry: currentEntry,
          agentId: currentTarget.agentId,
          sessionKey: currentTarget.canonicalKey,
        });
        if (resolveWorkerPlacementExecutionMode(currentRuntime) !== executionMode) {
          throw new WorkerDispatchTargetChangedError(
            `Session ${sessionKey} runtime changed to ${currentRuntime} before cloud worker dispatch. Retry.`,
          );
        }
        if (workspace.kind === "local") {
          const preflightWorkerWorkspace = await loadWorkerWorkspacePreflight();
          await preflightWorkerWorkspace({ localPath: workspace.path, signal });
        }
        authorize?.();
        if (requiredProfile) {
          if (
            getRuntimeConfig().cloudWorkers?.requiredProfile !== requiredProfile ||
            params.placements.get(sessionId)?.turnClaim
          ) {
            throw new WorkerDispatchTargetChangedError(
              "Required worker admission changed or a local turn is still active.",
            );
          }
          // Initial placement belongs to this held input. There is no executing local
          // owner to revoke, and clearing queues would discard the pending first turn.
          placement = await startDispatch();
          return;
        }
        placement = await startDispatch();
        clearSessionQueues(lifecycleIdentities);
        params.revokeSessionAuthority({
          sessionId,
          sessionKeys: lifecycleIdentities,
        });
        const released = await interruptSessionWorkAdmissions({
          scope: target.storePath,
          identities: lifecycleIdentities,
          timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
        });
        if (!released) {
          throw new Error(`Session ${sessionKey} is still active; dispatch stopped`);
        }
        await params.placements.waitForTurnClaimRelease(sessionId, {
          timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
        });
        await runExclusiveSessionStoreWrite(target.storePath, async () => {}, {
          reentrant: true,
        });
      },
      run: async () => {
        if (!placement) {
          throw new Error(`Session ${sessionKey} dispatch barrier did not start`);
        }
      },
    });
    if (!placement) {
      throw new Error(`Session ${sessionKey} dispatch barrier did not complete`);
    }
    return placement;
  };
}
