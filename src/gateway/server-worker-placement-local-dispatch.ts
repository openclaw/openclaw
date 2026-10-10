import { getRuntimeConfig } from "../config/config.js";
import { createLazyRuntimeNamedExport } from "../shared/lazy-runtime.js";
import {
  runWorkerPlacementHandoff,
  type WorkerPlacementHandoffParams,
} from "./server-worker-placement-move-barrier.js";
import {
  loadWorkerPlacementSessionRuntimeModule,
  WorkerDispatchTargetChangedError,
} from "./server-worker-placement-session-target.js";
import type { createWorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const loadWorkerWorkspacePreflight = createLazyRuntimeNamedExport(
  () => import("./worker-environments/workspace-sync-preflight.js"),
  "preflightWorkerWorkspace",
);

export function createGatewayWorkerPlacementLocalDispatchBarrier(
  params: WorkerPlacementHandoffParams & { placements: Pick<WorkerSessionPlacementStore, "get"> },
): Parameters<typeof createWorkerPlacementDispatchService>[0]["runLocalBarrier"] {
  return async (request) => {
    const sessionRuntime = await loadWorkerPlacementSessionRuntimeModule();
    const {
      sessionId,
      sessionKey,
      executionMode,
      requiredProfile,
      signal,
      authorize,
      startDispatch,
    } = request;
    return await runWorkerPlacementHandoff(
      params,
      { ...request, action: "dispatch" },
      sessionRuntime,
      async ({ config, target, entry, workspace, assertCurrent }) => {
        if (entry.archivedAt !== undefined) {
          throw new WorkerDispatchTargetChangedError(
            `Session ${sessionKey} was archived before cloud worker dispatch. Retry.`,
          );
        }
        const runtime = sessionRuntime.resolveWorkerPlacementSessionRuntime({
          cfg: config,
          entry,
          agentId: target.agentId,
          sessionKey: target.canonicalKey,
        });
        if (sessionRuntime.resolveWorkerPlacementExecutionMode(runtime) !== executionMode) {
          throw new WorkerDispatchTargetChangedError(
            `Session ${sessionKey} runtime changed to ${runtime} before cloud worker dispatch. Retry.`,
          );
        }
        if (workspace.kind === "local") {
          const preflightWorkerWorkspace = await loadWorkerWorkspacePreflight();
          await preflightWorkerWorkspace({ localPath: workspace.path, signal });
        }
        assertCurrent(getRuntimeConfig());
        authorize?.();
        if (
          requiredProfile &&
          (getRuntimeConfig().cloudWorkers?.requiredProfile !== requiredProfile ||
            params.placements.get(sessionId)?.turnClaim)
        ) {
          throw new WorkerDispatchTargetChangedError(
            "Required worker admission changed or a local turn is still active.",
          );
        }
        return await startDispatch();
      },
    );
  };
}
