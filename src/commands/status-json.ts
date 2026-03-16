import { callGateway } from "../gateway/call.js";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import { normalizeUpdateChannel, resolveUpdateChannelDisplay } from "../infra/update-channels.js";
import type { RuntimeEnv } from "../runtime.js";
import { getDaemonStatusSummary, getNodeDaemonStatusSummary } from "./status.daemon.js";
import { scanStatus } from "./status.scan.js";

function loadProviderUsage() {
  return import("../infra/provider-usage.js");
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
  const scan = await scanStatus({ json: true, timeoutMs: opts.timeoutMs, all: opts.all }, runtime);
  const securityAudit = null;

  const usage = opts.usage
    ? await loadProviderUsage().then(({ loadProviderUsageSummary }) =>
        loadProviderUsageSummary({ timeoutMs: opts.timeoutMs }),
      )
    : undefined;
  const health = opts.deep
    ? await callGateway({
        method: "health",
        params: { probe: true },
        timeoutMs: opts.timeoutMs,
        config: scan.cfg,
      }).catch(() => undefined)
    : undefined;
  const lastHeartbeat =
    opts.deep && scan.gatewayReachable
      ? await callGateway<HeartbeatEventPayload | null>({
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

  runtime.log(
    JSON.stringify(
      {
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
        securityAudit,
        secretDiagnostics: scan.secretDiagnostics,
        ...(health || usage || lastHeartbeat ? { health, usage, lastHeartbeat } : {}),
      },
      null,
      2,
    ),
  );
}
