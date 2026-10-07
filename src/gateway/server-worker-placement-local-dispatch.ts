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

const loadWorkerWorkspacePreflight = createLazyRuntimeNamedExport(
  () => import("./worker-environments/workspace-sync-preflight.js"),
  "preflightWorkerWorkspace",
);

export function createGatewayWorkerPlacementLocalDispatchBarrier(
  params: WorkerPlacementHandoffParams,
): Parameters<typeof createWorkerPlacementDispatchService>[0]["runLocalBarrier"] {
  return async (request) => {
    const sessionRuntime = await loadWorkerPlacementSessionRuntimeModule();
    const { sessionKey, executionMode, signal, authorize, startDispatch } = request;
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
        return await startDispatch();
      },
    );
  };
}
