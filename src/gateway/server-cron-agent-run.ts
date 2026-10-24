import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import type { CronServiceDeps } from "../cron/service/state.js";
import { executeScheduledPluginCommandDispatch } from "../plugins/plugin-command-runtime.js";
import { listPluginCommandScheduleHosts } from "../plugins/plugin-command-schedule-hosts.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { runPluginCommandScheduledTurn } from "./plugin-command-scheduled-run.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

type GatewayCronAgentParams = {
  deps: CliDeps;
  storePath: string;
  resolveCronAgent: (requested?: string | null) => { agentId: string; cfg: OpenClawConfig };
  resolveGatewayContext?: GatewayContextResolver;
  resolvePluginRegistry?: () => PluginRegistry | undefined;
};

/**
 * Agent-job deps of the Gateway cron service: the runner, and the loaded plugin instances the
 * scheduler claim can re-arm restartable command schedules onto.
 */
export function createGatewayCronAgentDeps(
  params: GatewayCronAgentParams,
): Pick<CronServiceDeps, "runIsolatedAgentJob" | "resolvePluginCommandScheduleHosts"> {
  return {
    runIsolatedAgentJob: createGatewayCronAgentJobRunner(params),
    resolvePluginCommandScheduleHosts: () =>
      listPluginCommandScheduleHosts(params.resolvePluginRegistry?.()),
  };
}

/** Select the reserved command path before any ordinary cron prompt processing. */
export function createGatewayCronAgentJobRunner(
  params: GatewayCronAgentParams,
): CronServiceDeps["runIsolatedAgentJob"] {
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
      cronStorePath: params.storePath,
      agentId,
      sessionKey: `cron:${job.id}`,
      trigger: "cron",
      lane: "cron",
    });
  };
}
