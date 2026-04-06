import {
  buildGatewayStatusJsonPayload,
  resolveStatusUpdateChannelInfo,
} from "./status-all/format.js";

export { resolveStatusUpdateChannelInfo } from "./status-all/format.js";

export function buildStatusJsonPayload(params: {
  summary: Record<string, unknown>;
  updateConfigChannel?: string | null;
  update: {
    installKind?: string | null;
    git?: {
      tag?: string | null;
      branch?: string | null;
    } | null;
  } & Record<string, unknown>;
  osSummary: unknown;
  memory: unknown;
  memoryPlugin: unknown;
  gatewayMode: "local" | "remote";
  gatewayConnection: {
    url: string;
    urlSource?: string;
  };
  remoteUrlMissing: boolean;
  gatewayReachable: boolean;
  gatewayProbe:
    | {
        connectLatencyMs?: number | null;
        error?: string | null;
      }
    | null
    | undefined;
  gatewaySelf:
    | {
        host?: string | null;
        ip?: string | null;
        version?: string | null;
        platform?: string | null;
      }
    | null
    | undefined;
  gatewayProbeAuthWarning?: string | null;
  gatewayService: unknown;
  nodeService: unknown;
  agents: unknown;
  secretDiagnostics: string[];
  securityAudit?: unknown;
  health?: unknown;
  usage?: unknown;
  lastHeartbeat?: unknown;
  pluginCompatibility?: Array<Record<string, unknown>> | null | undefined;
}) {
  const channelInfo = resolveStatusUpdateChannelInfo({
    updateConfigChannel: params.updateConfigChannel,
    update: params.update,
  });
  return {
    ...params.summary,
    os: params.osSummary,
    update: params.update,
    updateChannel: channelInfo.channel,
    updateChannelSource: channelInfo.source,
    memory: params.memory,
    memoryPlugin: params.memoryPlugin,
    gateway: buildGatewayStatusJsonPayload({
      gatewayMode: params.gatewayMode,
      gatewayConnection: params.gatewayConnection,
      remoteUrlMissing: params.remoteUrlMissing,
      gatewayReachable: params.gatewayReachable,
      gatewayProbe: params.gatewayProbe,
      gatewaySelf: params.gatewaySelf,
      gatewayProbeAuthWarning: params.gatewayProbeAuthWarning,
    }),
    gatewayService: params.gatewayService,
    nodeService: params.nodeService,
    agents: params.agents,
    secretDiagnostics: params.secretDiagnostics,
    ...(params.securityAudit ? { securityAudit: params.securityAudit } : {}),
    ...(params.pluginCompatibility
      ? {
          pluginCompatibility: {
            count: params.pluginCompatibility.length,
            warnings: params.pluginCompatibility,
          },
        }
      : {}),
    ...(params.health || params.usage || params.lastHeartbeat
      ? {
          health: params.health,
          usage: params.usage,
          lastHeartbeat: params.lastHeartbeat,
        }
      : {}),
  };
}
