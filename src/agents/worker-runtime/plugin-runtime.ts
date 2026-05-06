import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
import type { AgentRuntimeWorkerRunParams } from "./agent-runtime.types.js";

export function restoreAgentWorkerPluginRuntime(params: AgentRuntimeWorkerRunParams): void {
  ensureRuntimePluginsLoaded({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    allowGatewaySubagentBinding: true,
  });
}
