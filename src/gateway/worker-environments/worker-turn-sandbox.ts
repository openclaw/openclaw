import type { SandboxContext } from "../../agents/sandbox/types.js";
import type {
  PreparedSessionPlacementSandbox,
  SessionPlacementSandboxParams,
} from "../../agents/session-placement-admission.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import { assertWorkerSandboxEnvironment } from "./placement-target.js";
import type { WorkerTurnLauncherOptions } from "./worker-turn-launcher.types.js";

const loadPlacementSandbox = createLazyRuntimeModule(() => import("./placement-sandbox.js"));

/** Execution and read-only previews select the same saved remote sandbox. */
export function isActiveRemoteExecPlacementForSession(
  placement: WorkerSessionPlacementRecord | undefined,
  session: Pick<SessionPlacementSandboxParams, "agentId" | "sessionKey">,
): placement is Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return (
    placement?.state === "active" &&
    placement.executionMode === "remote-exec" &&
    placement.agentId === session.agentId &&
    placement.sessionKey === session.sessionKey
  );
}

/** Keep the prepared placement and remote sandbox under one disposable lifetime. */
export async function prepareWorkerTurnSandbox(
  options: Pick<WorkerTurnLauncherOptions, "placements" | "environments" | "resolveWorkspace">,
  params: SessionPlacementSandboxParams,
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
  if (!isActiveRemoteExecPlacementForSession(placement, params)) {
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
    const environment = options.environments.get(placement.environmentId);
    assertWorkerSandboxEnvironment(environment, placement, sandbox);
  };
  assertCurrent();
  return retain(sandbox, assertCurrent);
}
