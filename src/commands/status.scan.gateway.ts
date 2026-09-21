import { existsSync } from "node:fs";
import { measureCliCommandStartup } from "../cli/command-startup-timing.js";
import { readGatewayDispatchConfigWithShellEnvFallback } from "../config/gateway-dispatch-config.js";
import { resolveConfigPath } from "../config/paths.js";
import { resolveGatewayAuthTokenSourceConflict } from "../gateway/auth-token-source-conflict.js";
import { callGateway, isImplicitLocalGatewayTarget } from "../gateway/call.js";
import { resolveOsSummary } from "../infra/os-summary.js";
import { resolveMemoryPluginStatus } from "../status/memory-plugin.js";
import type { StatusSummary } from "../status/summary.js";
import {
  resolveStatusGatewayProbeTimeoutMs,
  type StatusGatewayProbeBudget,
} from "./status.gateway-probe-budget.js";
import { buildStatusScanResult, type StatusJsonScanResult } from "./status.scan-result.js";
import {
  buildColdStartStatusSummary,
  createStatusScanCoreBootstrap,
} from "./status.scan.bootstrap-shared.js";
import { resolveGatewayProbeSnapshot, type GatewayProbeSnapshot } from "./status.scan.shared.js";

/** The running Gateway owns fleet admission and status; local discovery is the offline fallback. */
export async function scanStatusJsonGateway(
  opts: StatusGatewayProbeBudget & {
    all?: boolean;
  },
): Promise<{ scan?: StatusJsonScanResult; gatewaySnapshot?: GatewayProbeSnapshot }> {
  const env = process.env;
  const configPath = resolveConfigPath(env);
  if (!existsSync(configPath)) {
    return {};
  }
  const cfg = await measureCliCommandStartup(
    "status.connection-config",
    () => readGatewayDispatchConfigWithShellEnvFallback({ configPath, env }).catch(() => null),
    { env },
  );
  if (!cfg) {
    return {};
  }
  let projectionError = "Gateway status is unavailable.";
  const gatewaySnapshot = await resolveGatewayProbeSnapshot({
    cfg,
    configPath,
    env,
    opts,
  });
  if (!gatewaySnapshot.gatewayReachable) {
    return { gatewaySnapshot };
  }
  const status = await measureCliCommandStartup(
    "status.gateway-projection",
    () => {
      const timeoutMs = resolveStatusGatewayProbeTimeoutMs(opts);
      if (timeoutMs === 0) {
        projectionError = "Gateway probe budget exhausted before status projection.";
        return Promise.resolve(null);
      }
      return callGateway<StatusSummary>({
        config: cfg,
        configPath,
        method: "status",
        params: { includeChannelSummary: false, includeCliProjection: true },
        timeoutMs,
      }).catch((error: unknown) => {
        projectionError = error instanceof Error ? error.message : String(error);
        return null;
      });
    },
    { config: cfg, env },
  );
  const { cliProjection, ...summary }: StatusSummary = status ?? buildColdStartStatusSummary();
  if (status) {
    gatewaySnapshot.gatewayReachable = true;
    gatewaySnapshot.gatewayProbe = {
      ...gatewaySnapshot.gatewayProbe,
      ok: true,
      gatewayReached: true,
      url: gatewaySnapshot.gatewayConnection.url,
      connectLatencyMs: gatewaySnapshot.gatewayProbe?.connectLatencyMs ?? null,
      error: null,
      close: null,
      auth: { role: "operator", scopes: ["operator.read"], capability: "read_only" },
      health: null,
      status,
      presence: gatewaySnapshot.gatewayProbe?.presence ?? null,
      configSnapshot: null,
    };
  }
  const agentNames = new Map(cliProjection?.agents.rows.map((agent) => [agent.id, agent.name]));
  const agentStatus: StatusJsonScanResult["agentStatus"] = {
    defaultId: cliProjection?.agents.defaultId ?? null,
    ownership: cliProjection?.agents.ownership ?? null,
    selectionRequired: cliProjection?.agents.selectionRequired ?? null,
    agents: summary.sessions.byAgent.map((agent) => ({
      id: agent.agentId,
      name: agentNames.get(agent.agentId),
      ...(agent.status ? { status: agent.status } : {}),
      ...(agent.admissionRefusal ? { admissionRefusal: agent.admissionRefusal } : {}),
      workspaceDir: null,
      bootstrapPending: null,
      sessionsPath: agent.path,
      sessionsCount: agent.count,
      lastUpdatedAt: agent.recent[0]?.updatedAt ?? null,
      lastActiveAgeMs: agent.recent[0]?.age ?? null,
    })),
    totalSessions: summary.sessions.count,
    bootstrapPendingCount: null,
  };
  const localGateway = await isImplicitLocalGatewayTarget({ config: cfg });
  // Update checks describe this CLI installation, not an explicitly selected remote Gateway.
  const statusConfig =
    localGateway && cliProjection?.updateChannel
      ? { ...cfg, update: { channel: cliProjection.updateChannel } }
      : cfg;
  const bootstrap = await createStatusScanCoreBootstrap({
    coldStart: false,
    cfg: statusConfig,
    configPath,
    env,
    hasConfiguredChannels: false,
    opts,
    fetchGitUpdate: opts.all === true,
    includeRegistryUpdate: opts.all === true,
    gatewaySnapshot,
    getAgentLocalStatuses: async () => agentStatus,
    getTailnetHostname: async (runner) =>
      (await import("../infra/tailscale.js")).getTailnetHostname(runner),
    getUpdateCheckResult: async (params) =>
      (await import("./status.update.js")).getUpdateCheckResult(params),
  });
  const [tailscaleDns, tailscaleHttpsUrl, update] = await Promise.all([
    bootstrap.tailscaleDnsPromise,
    bootstrap.resolveTailscaleHttpsUrl(),
    bootstrap.updatePromise,
  ]);
  const conflict = resolveGatewayAuthTokenSourceConflict({ cfg, env });
  const scan = buildStatusScanResult({
    env,
    cfg: statusConfig,
    sourceConfig: cfg,
    configDiagnostics: null,
    secretDiagnostics: conflict ? [conflict.diagnostic] : [],
    osSummary: resolveOsSummary(),
    tailscaleMode: bootstrap.tailscaleMode,
    tailscaleDns,
    tailscaleHttpsUrl,
    update,
    gatewaySnapshot,
    channelIssues: [],
    agentStatus,
    channels: { rows: [], details: [] },
    summary,
    memory: null,
    memoryPlugin: cliProjection?.memoryPlugin ?? resolveMemoryPluginStatus(cfg),
    pluginCompatibility: [],
    collection: {
      source: "gateway",
      notCollected: [
        ...(!localGateway
          ? [
              {
                fields: ["updateChannel", "updateChannelSource"],
                reason:
                  "The remote Gateway's update channel does not describe this CLI installation; its local channel override was not collected.",
              },
            ]
          : []),
        ...(!status
          ? [
              {
                fields: ["agents", "sessions", "heartbeat", "tasks", "taskAudit"],
                reason: projectionError,
              },
            ]
          : []),
        ...(!cliProjection
          ? [
              {
                fields: [
                  "agents.defaultId",
                  "agents.ownership",
                  "agents.selectionRequired",
                  "agents.agents.*.name",
                  "updateChannel",
                ],
                reason: "This Gateway does not expose the CLI configuration projection.",
              },
            ]
          : []),
        {
          fields: [
            "agents.agents.*.workspaceDir",
            "agents.agents.*.bootstrapPending",
            "agents.bootstrapPendingCount",
          ],
          reason: "Online status does not inspect local agent workspaces.",
        },
        {
          fields: [
            "sessions.paths",
            "sessions.defaults",
            "sessions.recent",
            "sessions.byAgent.*.path",
            "sessions.byAgent.*.recent",
            "agents.agents.*.admissionRefusal",
            "agents.agents.*.lastUpdatedAt",
            "agents.agents.*.lastActiveAgeMs",
          ],
          reason:
            "Gateway status preserves operator.read redaction of session details and admission refusals.",
        },
        {
          fields: ["configDiagnostics", "secretDiagnostics"],
          reason:
            "Only Gateway connection configuration is read locally; degradedSecretOwners reports Gateway runtime availability.",
        },
        ...(opts.all
          ? [
              {
                fields: ["memory", "pluginCompatibility"],
                reason: "Local plugin inspection is not collected in online status.",
              },
            ]
          : []),
      ],
    },
  });
  return { scan };
}
