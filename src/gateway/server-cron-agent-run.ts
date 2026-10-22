import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import type { CronServiceDeps } from "../cron/service/state.js";
import { executeScheduledPluginCommandDispatch } from "../plugins/plugin-command-runtime.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { runPluginCommandScheduledTurn } from "./plugin-command-scheduled-run.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

/** Select the reserved command path before any ordinary cron prompt processing. */
export function createGatewayCronAgentJobRunner(params: {
  deps: CliDeps;
  resolveCronAgent: (requested?: string | null) => { agentId: string; cfg: OpenClawConfig };
  resolveGatewayContext?: GatewayContextResolver;
  resolvePluginRegistry?: () => PluginRegistry | undefined;
}): CronServiceDeps["runIsolatedAgentJob"] {
  return async (request) => {
    const { job } = request;
    const { agentId, cfg } = params.resolveCronAgent(job.agentId);
    const pluginCommandResult = await runPluginCommandScheduledTurn({
      request,
      cfg,
      agentId,
      resolveGatewayContext: params.resolveGatewayContext,
      resolvePluginRegistry: params.resolvePluginRegistry,
      executeScheduledDispatch: executeScheduledPluginCommandDispatch,
    });
    if (pluginCommandResult) {
      return pluginCommandResult;
    }
    return await runCronIsolatedAgentTurn({
      ...request,
      cfg,
      deps: params.deps,
      agentId,
      sessionKey: `cron:${job.id}`,
      trigger: "cron",
      lane: "cron",
    });
  };
}
