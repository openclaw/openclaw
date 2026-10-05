import type { SandboxContext } from "../../agents/sandbox/types.js";
import type { PreparedSessionPlacementSandbox } from "../../agents/session-placement-admission.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import type { WorkerTurnLauncherOptions } from "./worker-turn-launcher.types.js";

const loadPlacementSandbox = createLazyRuntimeModule(() => import("./placement-sandbox.js"));

export async function prepareWorkerTurnSandbox(
  options: Pick<WorkerTurnLauncherOptions, "placements" | "environments" | "resolveWorkspace">,
  params: {
    agentId: string;
    config?: OpenClawConfig;
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
  },
): Promise<PreparedSessionPlacementSandbox> {
  using cleanup = new DisposableStack();
  const prepared = await options.placements.prepareRuntimeRefresh(params.sessionId);
  cleanup.defer(prepared.release);
  const retain = (
    sandbox: SandboxContext | null,
    assertCurrent = prepared.assertCurrent,
  ): PreparedSessionPlacementSandbox => {
    const lifetime = cleanup.move();
    return { sandbox, assertCurrent, [Symbol.dispose]: () => lifetime.dispose() };
  };
  const placement = prepared.placement;
  if (
    placement?.state !== "active" ||
    placement.executionMode !== "remote-exec" ||
    placement.agentId !== params.agentId ||
    placement.sessionKey !== params.sessionKey
  ) {
    return retain(null);
  }
  const workspace = await options.resolveWorkspace({
    sessionId: placement.sessionId,
    agentId: placement.agentId,
    sessionKey: placement.sessionKey,
  });
  prepared.assertCurrent();
  const { createRemoteExecPlacementSandbox } = await loadPlacementSandbox();
  prepared.assertCurrent();
  const sandbox = await createRemoteExecPlacementSandbox({
    config: params.config,
    environments: options.environments,
    workspaceDir: workspace.kind === "local" ? workspace.path : placement.remoteWorkspaceDir,
    placement,
  });
  const assertCurrent = () => {
    prepared.assertCurrent();
    const currentEnvironment = options.environments.get(placement.environmentId);
    if (
      currentEnvironment?.state !== "attached" ||
      currentEnvironment.environmentId !== placement.environmentId ||
      currentEnvironment.ownerEpoch !== placement.activeOwnerEpoch ||
      currentEnvironment.attachedSessionIds.length !== 1 ||
      currentEnvironment.attachedSessionIds[0] !== placement.sessionId ||
      (sandbox.backendId === "node" && currentEnvironment.nodeDeviceId !== sandbox.placementNodeId)
    ) {
      throw new Error("Remote-exec environment changed while preparing its sandbox");
    }
  };
  assertCurrent();
  return retain(sandbox, assertCurrent);
}
