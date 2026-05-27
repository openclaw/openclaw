import type { OpenClawConfig } from "../config/types.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import { buildStatusJsonPayload } from "./status-json-payload.ts";
import { buildStatusOverviewSurfaceFromScan } from "./status-overview-surface.ts";
import { resolveStatusRuntimeSnapshot } from "./status-runtime-shared.ts";

type StatusJsonScanLike = {
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  summary: Record<string, unknown>;
  update: UpdateCheckResult;
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
  gatewayProbeAuth:
    | {
        token?: string;
        password?: string;
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
  agentStatus: unknown;
  secretDiagnostics: string[];
  pluginCompatibility?: Array<Record<string, unknown>> | null | undefined;
};

export async function resolveStatusJsonOutput(params: {
  scan: StatusJsonScanLike;
  opts: {
    deep?: boolean;
    usage?: boolean;
    timeoutMs?: number;
  };
  includeSecurityAudit: boolean;
  includePluginCompatibility?: boolean;
  suppressHealthErrors?: boolean;
}) {
  const { scan, opts } = params;
  const { securityAudit, usage, health, lastHeartbeat, gatewayService, nodeService } =
    await resolveStatusRuntimeSnapshot({
      config: scan.cfg,
      sourceConfig: scan.sourceConfig,
      timeoutMs: opts.timeoutMs,
      usage: opts.usage,
      deep: opts.deep,
      gatewayReachable: scan.gatewayReachable,
      includeSecurityAudit: params.includeSecurityAudit,
      suppressHealthErrors: params.suppressHealthErrors,
    });

  return buildStatusJsonPayload({
    summary: scan.summary,
    surface: buildStatusOverviewSurfaceFromScan({
      scan: scan as never,
      gatewayService,
      nodeService,
    }),
    osSummary: scan.osSummary,
    memory: scan.memory,
    memoryPlugin: scan.memoryPlugin,
    agents: scan.agentStatus,
    secretDiagnostics: scan.secretDiagnostics,
    securityAudit,
    health,
    usage,
    lastHeartbeat,
    pluginCompatibility: params.includePluginCompatibility ? scan.pluginCompatibility : undefined,
  });
}
