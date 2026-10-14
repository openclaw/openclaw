import { measureCliCommandStartup } from "../cli/command-startup-timing.js";
import type { OpenClawConfig } from "../config/types.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import { runExec } from "../process/exec.js";
import type { StatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import {
  buildTailscaleHttpsUrl,
  resolveGatewayProbeSnapshot,
  type GatewayProbeSnapshot,
} from "./status.scan.shared.js";
import type { getUpdateCheckResult } from "./status.update.js";

function buildColdStartUpdateResult(): UpdateCheckResult {
  return {
    root: null,
    installKind: "unknown",
    packageManager: "unknown",
  };
}

function buildColdStartAgentLocalStatuses() {
  return {
    defaultId: "main",
    agents: [],
    totalSessions: 0,
    bootstrapPendingCount: 0,
  };
}

/** Builds an empty summary for cold-start status paths that skip network and session work. */
export function buildColdStartStatusSummary() {
  return {
    runtimeVersion: null,
    heartbeat: {
      defaultAgentId: "main",
      agents: [],
    },
    channelSummary: [],
    queuedSystemEvents: [],
    degradedSecretOwners: [],
    sessions: {
      paths: [],
      count: 0,
      defaults: { model: null, contextTokens: null },
      recent: [],
      byAgent: [],
    },
  };
}

type StatusScanCoreBootstrapParams<TAgentStatus> = {
  coldStart: boolean;
  cfg: OpenClawConfig;
  configPath: string;
  env: NodeJS.ProcessEnv;
  hasConfiguredChannels: boolean;
  opts: StatusGatewayProbeBudget & { all?: boolean };
  fetchGitUpdate?: boolean;
  includeRegistryUpdate?: boolean;
  includeLocalStatusRpcFallback?: boolean;
  gatewaySnapshot?: GatewayProbeSnapshot;
  onGatewayProgress?: (phase: string) => void;
  getTailnetHostname: (runner: typeof runExec) => Promise<string | null>;
  getUpdateCheckResult: typeof getUpdateCheckResult;
  getAgentLocalStatuses: (cfg: OpenClawConfig) => Promise<TAgentStatus>;
};

export async function createStatusScanCoreBootstrap<TAgentStatus>(
  params: StatusScanCoreBootstrapParams<TAgentStatus>,
) {
  const tailscaleMode = params.cfg.gateway?.tailscale?.mode ?? "off";
  // First-run users without channels should get instant status instead of waiting on network probes.
  const skipColdStartNetworkChecks =
    params.coldStart && !params.hasConfiguredChannels && params.opts.all !== true;
  const statusTimeoutMs = params.opts.timeoutMs ?? 10_000;
  const tailscaleTimeoutMs = Math.min(1200, statusTimeoutMs);
  const tailscaleDnsPromise =
    tailscaleMode === "off"
      ? Promise.resolve<string | null>(null)
      : params
          .getTailnetHostname((cmd, args, options) =>
            runExec(cmd, args, {
              ...(typeof options === "object" ? options : {}),
              timeoutMs: tailscaleTimeoutMs,
            }),
          )
          .catch(() => null);
  // Update checks can hit git/registry, so cold-start status uses a synthetic unknown result.
  const updatePromise = skipColdStartNetworkChecks
    ? Promise.resolve(buildColdStartUpdateResult())
    : params.getUpdateCheckResult({
        timeoutMs: statusTimeoutMs,
        fetchGit: params.fetchGitUpdate ?? true,
        includeRegistry: params.includeRegistryUpdate ?? true,
        updateConfigChannel: params.cfg.update?.channel ?? null,
      });
  const agentStatusPromise = skipColdStartNetworkChecks
    ? Promise.resolve(buildColdStartAgentLocalStatuses() as TAgentStatus)
    : params.getAgentLocalStatuses(params.cfg);
  const gatewayProbePromise = params.gatewaySnapshot
    ? Promise.resolve(params.gatewaySnapshot)
    : measureCliCommandStartup(
        "status.gateway-probe",
        () =>
          resolveGatewayProbeSnapshot({
            cfg: params.cfg,
            configPath: params.configPath,
            env: params.env,
            opts: {
              ...params.opts,
              ...(skipColdStartNetworkChecks ? { skipProbe: true } : {}),
              localStatusRpcFallback: params.includeLocalStatusRpcFallback !== false,
              onProgress: params.onGatewayProgress,
            },
          }),
        { config: params.cfg, env: params.env },
      );

  return {
    tailscaleMode,
    tailscaleDnsPromise,
    updatePromise,
    agentStatusPromise,
    gatewayProbePromise,
    skipColdStartNetworkChecks,
    resolveTailscaleHttpsUrl: async () =>
      buildTailscaleHttpsUrl({
        tailscaleMode,
        tailscaleDns: await tailscaleDnsPromise,
        controlUiBasePath: params.cfg.gateway?.controlUi?.basePath,
      }),
  };
}
