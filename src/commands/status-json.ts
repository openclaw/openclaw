import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import { normalizeUpdateChannel, resolveUpdateChannelDisplay } from "../infra/update-channels.js";
import { buildPluginRuntimeSummaries } from "../plugins/status.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { getDaemonStatusSummary, getNodeDaemonStatusSummary } from "./status.daemon.js";
import { scanStatusJsonFast } from "./status.scan.fast-json.js";

let providerUsagePromise: Promise<typeof import("../infra/provider-usage.js")> | undefined;
let securityAuditModulePromise: Promise<typeof import("../security/audit.runtime.js")> | undefined;
let gatewayCallModulePromise: Promise<typeof import("../gateway/call.js")> | undefined;

function loadProviderUsage() {
  providerUsagePromise ??= import("../infra/provider-usage.js");
  return providerUsagePromise;
}

function loadSecurityAuditModule() {
  securityAuditModulePromise ??= import("../security/audit.runtime.js");
  return securityAuditModulePromise;
}

function loadGatewayCallModule() {
  gatewayCallModulePromise ??= import("../gateway/call.js");
  return gatewayCallModulePromise;
}

export async function statusJsonCommand(
  opts: {
    deep?: boolean;
    usage?: boolean;
    timeoutMs?: number;
    all?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const scan = await scanStatusJsonFast({ timeoutMs: opts.timeoutMs, all: opts.all }, runtime);
  const securityAudit = opts.all
    ? await loadSecurityAuditModule().then(({ runSecurityAudit }) =>
        runSecurityAudit({
          config: scan.cfg,
          sourceConfig: scan.sourceConfig,
          deep: false,
          includeFilesystem: true,
          includeChannelSecurity: true,
        }),
      )
    : undefined;

  const usage = opts.usage
    ? await loadProviderUsage().then(({ loadProviderUsageSummary }) =>
        loadProviderUsageSummary({ timeoutMs: opts.timeoutMs }),
      )
    : undefined;
  const gatewayCall = opts.deep
    ? await loadGatewayCallModule().then((mod) => mod.callGateway)
    : null;
  const health =
    gatewayCall != null
      ? await gatewayCall({
          method: "health",
          params: { probe: true },
          timeoutMs: opts.timeoutMs,
          config: scan.cfg,
        }).catch(() => undefined)
      : undefined;
  const lastHeartbeat =
    gatewayCall != null && scan.gatewayReachable
      ? await gatewayCall<HeartbeatEventPayload | null>({
          method: "last-heartbeat",
          params: {},
          timeoutMs: opts.timeoutMs,
          config: scan.cfg,
        }).catch(() => null)
      : null;

  const [daemon, nodeDaemon] = await Promise.all([
    getDaemonStatusSummary(),
    getNodeDaemonStatusSummary(),
  ]);
  const channelInfo = resolveUpdateChannelDisplay({
    configChannel: normalizeUpdateChannel(scan.cfg.update?.channel),
    installKind: scan.update.installKind,
    gitTag: scan.update.git?.tag ?? null,
    gitBranch: scan.update.git?.branch ?? null,
  });
  const pluginRuntime = buildPluginRuntimeSummaries({
    config: scan.cfg,
    pluginIds: ["openviking"],
  });

  writeRuntimeJson(runtime, {
    ...scan.summary,
    os: scan.osSummary,
    update: scan.update,
    updateChannel: channelInfo.channel,
    updateChannelSource: channelInfo.source,
    memory: scan.memory,
    memoryPlugin: scan.memoryPlugin,
    pluginRuntime,
    gateway: {
      mode: scan.gatewayMode,
      url: scan.gatewayConnection.url,
      urlSource: scan.gatewayConnection.urlSource,
      misconfigured: scan.remoteUrlMissing,
      reachable: scan.gatewayReachable,
      connectLatencyMs: scan.gatewayProbe?.connectLatencyMs ?? null,
      self: scan.gatewaySelf,
      error: scan.gatewayProbe?.error ?? null,
      authWarning: scan.gatewayProbeAuthWarning ?? null,
    },
    gatewayService: daemon,
    nodeService: nodeDaemon,
    agents: scan.agentStatus,
    secretDiagnostics: scan.secretDiagnostics,
    ...(securityAudit ? { securityAudit } : {}),
    ...(health || usage || lastHeartbeat ? { health, usage, lastHeartbeat } : {}),
  });
}
