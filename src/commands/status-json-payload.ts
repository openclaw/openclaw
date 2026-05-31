import { resolveStatusUpdateChannelInfo } from "./status-all/format.js";
import {
  buildStatusGatewayJsonPayloadFromSurface,
  type StatusOverviewSurface,
} from "./status-overview-surface.ts";

/**
 * Builds the stable `openclaw status --json` payload from scan/runtime pieces.
 *
 * Optional runtime sections are omitted unless they were requested or resolved,
 * keeping default JSON output compact while preserving field names for callers.
 */
export function buildStatusJsonPayload(params: {
  summary: Record<string, unknown>;
  surface: StatusOverviewSurface;
  osSummary: unknown;
  memory: unknown;
  memoryPlugin: unknown;
  agents: unknown;
  secretDiagnostics: string[];
  securityAudit?: unknown;
  health?: unknown;
  usage?: unknown;
  lastHeartbeat?: unknown;
  pluginCompatibility?: Array<Record<string, unknown>> | null | undefined;
}) {
  const channelInfo = resolveStatusUpdateChannelInfo({
    updateConfigChannel: params.surface.cfg.update?.channel ?? undefined,
    update: params.surface.update,
  });
  return {
    ...params.summary,
    os: params.osSummary,
    update: params.surface.update,
    updateChannel: channelInfo.channel,
    updateChannelSource: channelInfo.source,
    memory: params.memory,
    memoryPlugin: params.memoryPlugin,
    gateway: buildStatusGatewayJsonPayloadFromSurface({ surface: params.surface }),
    gatewayService: params.surface.gatewayService,
    nodeService: params.surface.nodeService,
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
    // Keep deep/usage-only fields grouped so consumers can distinguish default
    // status JSON from explicitly requested runtime probes.
    ...(params.health || params.usage || params.lastHeartbeat
      ? {
          health: params.health,
          usage: params.usage,
          lastHeartbeat: params.lastHeartbeat,
        }
      : {}),
  };
}
