import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { scanStatusJsonFast } from "./status.scan.fast-json.js";

let providerUsagePromise: Promise<typeof import("../infra/provider-usage.js")> | undefined;
let securityAuditModulePromise: Promise<typeof import("../security/audit.runtime.js")> | undefined;
let gatewayCallModulePromise: Promise<typeof import("../gateway/call.js")> | undefined;
let updateChannelsModulePromise: Promise<typeof import("../infra/update-channels.js")> | undefined;
let statusDaemonModulePromise: Promise<typeof import("./status.daemon.js")> | undefined;

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

function loadUpdateChannelsModule() {
  updateChannelsModulePromise ??= import("../infra/update-channels.js");
  return updateChannelsModulePromise;
}

function loadStatusDaemonModule() {
  statusDaemonModulePromise ??= import("./status.daemon.js");
  return statusDaemonModulePromise;
}

function shouldUseLeanDaemonSummary(scan: { cfg?: object; sourceConfig?: object }): boolean {
  return (
    Object.keys(scan.sourceConfig ?? {}).length === 0 && Object.keys(scan.cfg ?? {}).length === 0
  );
}

function buildLeanDaemonSummary(label: string) {
  return {
    label,
    installed: null,
    managedByOpenClaw: false,
    externallyManaged: false,
    loadedText: "unknown",
    runtimeShort: null,
  };
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

  const daemonSummariesPromise = shouldUseLeanDaemonSummary(scan)
    ? Promise.resolve([buildLeanDaemonSummary("Daemon"), buildLeanDaemonSummary("Node")] as const)
    : loadStatusDaemonModule().then(
        ({ getDaemonStatusSummary, getNodeDaemonStatusSummary }) =>
          Promise.all([getDaemonStatusSummary(), getNodeDaemonStatusSummary()]) as Promise<
            readonly [
              Awaited<ReturnType<typeof getDaemonStatusSummary>>,
              Awaited<ReturnType<typeof getNodeDaemonStatusSummary>>,
            ]
          >,
      );
  const [updateChannels, [daemon, nodeDaemon]] = await Promise.all([
    loadUpdateChannelsModule(),
    daemonSummariesPromise,
  ]);
  const channelInfo = updateChannels.resolveUpdateChannelDisplay({
    configChannel: updateChannels.normalizeUpdateChannel(scan.cfg.update?.channel),
    installKind: scan.update.installKind,
    gitTag: scan.update.git?.tag ?? null,
    gitBranch: scan.update.git?.branch ?? null,
  });

  writeRuntimeJson(runtime, {
    ...scan.summary,
    os: scan.osSummary,
    update: scan.update,
    updateChannel: channelInfo.channel,
    updateChannelSource: channelInfo.source,
    memory: scan.memory,
    memoryPlugin: scan.memoryPlugin,
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
