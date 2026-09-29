// Shared runtime probes used by status text and JSON commands.
// Heavy modules stay lazily loaded so fast status output avoids security/provider/gateway costs.

import type { Result } from "@openclaw/normalization-core/result";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { OpenClawConfig } from "../config/types.js";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { HealthSummary } from "./health.js";
import type { StatusUsageSummaryOptions } from "./status-usage.runtime.js";
import { getDaemonStatusSummary, getNodeDaemonStatusSummary } from "./status.daemon.js";
import { resolveStatusGatewayProbeTimeoutMs } from "./status.gateway-probe-budget.js";

const statusUsageModuleLoader = createLazyImportLoader(() => import("./status-usage.runtime.js"));
const securityAuditModuleLoader = createLazyImportLoader(
  () => import("../security/audit.runtime.js"),
);
const gatewayCallModuleLoader = createLazyImportLoader(() => import("../gateway/call.js"));

/** Runs the lightweight security audit used by status JSON/all output. */
export async function resolveStatusSecurityAudit(params: {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  timeoutMs?: number;
}) {
  const { runSecurityAudit } = await securityAuditModuleLoader.load();
  // The audit owns setup-backed capabilities; inventory projections can name
  // accounts without carrying their channel security adapters.
  return await runSecurityAudit({
    config: params.config,
    sourceConfig: params.sourceConfig,
    deep: false,
    ...(params.timeoutMs !== undefined ? { deepTimeoutMs: params.timeoutMs } : {}),
    includeFilesystem: true,
    includeChannelSecurity: true,
    loadPluginSecurityCollectors: false,
  });
}

/** Loads optional usage and its credential resolver only when requested. */
export async function resolveStatusUsageSummary(params: StatusUsageSummaryOptions) {
  return (await statusUsageModuleLoader.load()).resolveStatusUsageSummary(params);
}

/** Calls gateway health and lets errors propagate to deep status callers. */
export async function resolveStatusGatewayHealth(params: {
  config: OpenClawConfig;
  timeoutMs?: number;
  gatewayProbeDeadlineMs: number;
}) {
  const { callGateway } = await gatewayCallModuleLoader.load();
  const timeoutMs = resolveStatusGatewayProbeTimeoutMs(params);
  if (timeoutMs === 0) {
    throw new Error("Gateway probe budget exhausted before health check.");
  }
  return await callGateway<HealthSummary>({
    method: "health",
    params: { probe: true },
    timeoutMs,
    config: params.config,
  });
}

/** Calls gateway health but converts unreachable/failing probes into an error object. */
export async function resolveStatusGatewayHealthSafe(params: {
  config: OpenClawConfig;
  timeoutMs?: number;
  gatewayProbeDeadlineMs: number;
  gatewayReachable: boolean;
  gatewayProbeError?: string | null;
  callOverrides?: {
    url: string;
    token?: string;
    password?: string;
  };
}) {
  if (!params.gatewayReachable) {
    // Preserve the probe error so status-all can explain why health was not called.
    return { error: params.gatewayProbeError ?? "gateway unreachable" };
  }
  const { callGateway } = await gatewayCallModuleLoader.load();
  const timeoutMs = resolveStatusGatewayProbeTimeoutMs(params);
  if (timeoutMs === 0) {
    return { error: "Gateway probe budget exhausted before health check." };
  }
  return await callGateway<HealthSummary>({
    method: "health",
    params: { probe: true },
    timeoutMs,
    config: params.config,
    ...params.callOverrides,
  }).catch((err: unknown) => ({ error: String(err) }));
}

export type StatusGatewayDiagnosticsResult = Result<unknown, string>;

/** Reads gateway diagnostics while preserving whether data or an unavailable outcome was observed. */
export async function resolveStatusGatewayDiagnosticsSafe(params: {
  config: OpenClawConfig;
  timeoutMs?: number;
  gatewayProbeDeadlineMs: number;
  gatewayReachable: boolean;
  type?: string;
  callOverrides?: {
    url: string;
    token?: string;
    password?: string;
  };
}): Promise<StatusGatewayDiagnosticsResult> {
  if (!params.gatewayReachable) {
    return { ok: false, error: "gateway unreachable" };
  }
  const { callGateway } = await gatewayCallModuleLoader.load();
  const timeoutMs = resolveStatusGatewayProbeTimeoutMs(params);
  if (timeoutMs === 0) {
    return { ok: false, error: "Gateway probe budget exhausted before diagnostics." };
  }
  return await callGateway<unknown>({
    method: "diagnostics.stability",
    params: { limit: 1000, ...(params.type ? { type: params.type } : {}) },
    timeoutMs,
    config: params.config,
    ...params.callOverrides,
  }).then<StatusGatewayDiagnosticsResult, StatusGatewayDiagnosticsResult>(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error: String(error) }),
  );
}

/** Reads the most recent gateway heartbeat only when the gateway probe succeeded. */
async function resolveStatusLastHeartbeat(params: {
  config: OpenClawConfig;
  timeoutMs?: number;
  gatewayProbeDeadlineMs: number;
  gatewayReachable: boolean;
}) {
  if (!params.gatewayReachable) {
    return null;
  }
  const { callGateway } = await gatewayCallModuleLoader.load();
  const timeoutMs = resolveStatusGatewayProbeTimeoutMs(params);
  if (timeoutMs === 0) {
    return null;
  }
  return await callGateway<HeartbeatEventPayload | null>({
    method: "last-heartbeat",
    params: {},
    timeoutMs,
    config: params.config,
  }).catch(() => null);
}

// Default bound for service-manager probes when status runs without an explicit
// --timeout, so a wedged systemd/launchd socket cannot hang `openclaw status`.
const DEFAULT_SERVICE_PROBE_TIMEOUT_MS = 5000;

/** Preserve independent service diagnostics when local status collection refuses state. */
export async function reportStatusScanFailure(
  error: unknown,
  runtime: RuntimeEnv,
  timeoutMs?: number,
): Promise<never> {
  try {
    const { installationDrift } = await getDaemonStatusSummary(
      timeoutMs ?? DEFAULT_SERVICE_PROBE_TIMEOUT_MS,
    );
    if (installationDrift) {
      runtime.error(sanitizeTerminalText(installationDrift));
    }
  } catch {
    // Optional diagnostics must not replace the original collection or schema refusal.
  }
  throw error;
}

/** Resolves launchd/systemd summaries for the gateway and node services together. */
export async function resolveStatusServiceSummaries(timeoutMs?: number) {
  const probeTimeoutMs = timeoutMs ?? DEFAULT_SERVICE_PROBE_TIMEOUT_MS;
  return await Promise.all([
    getDaemonStatusSummary(probeTimeoutMs),
    getNodeDaemonStatusSummary(probeTimeoutMs),
  ]);
}

type StatusUsageSummary = Awaited<ReturnType<typeof resolveStatusUsageSummary>>;
type StatusGatewayHealth = Awaited<ReturnType<typeof resolveStatusGatewayHealth>>;
type StatusSecurityAudit = Awaited<ReturnType<typeof resolveStatusSecurityAudit>>;

/** Resolves the full runtime snapshot, including optional security audit, for status JSON/text. */
export async function resolveStatusRuntimeSnapshot(params: {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  timeoutMs?: number;
  gatewayProbeDeadlineMs: number;
  agentId?: string;
  usage?: boolean;
  deep?: boolean;
  gatewayReachable: boolean;
  gatewayStartupPhase?: string;
  gatewayProbeError?: string | null;
  includeSecurityAudit?: boolean;
  suppressHealthErrors?: boolean;
  resolveSecurityAudit?: (input: {
    config: OpenClawConfig;
    sourceConfig: OpenClawConfig;
    timeoutMs?: number;
  }) => Promise<StatusSecurityAudit>;
  resolveUsage?: (input: StatusUsageSummaryOptions) => Promise<StatusUsageSummary>;
  resolveHealth?: (input: {
    config: OpenClawConfig;
    timeoutMs?: number;
    gatewayProbeDeadlineMs: number;
  }) => Promise<StatusGatewayHealth>;
}) {
  const securityAudit = params.includeSecurityAudit
    ? await (params.resolveSecurityAudit ?? resolveStatusSecurityAudit)({
        config: params.config,
        sourceConfig: params.sourceConfig,
        timeoutMs: params.timeoutMs,
      })
    : undefined;
  const resolveUsageSummary = params.resolveUsage ?? resolveStatusUsageSummary;
  const resolveGatewayHealthSummary = params.resolveHealth ?? resolveStatusGatewayHealth;
  const usage = params.usage
    ? await resolveUsageSummary({
        timeoutMs: resolveStatusGatewayProbeTimeoutMs(params),
        gatewayProbeDeadlineMs: params.gatewayProbeDeadlineMs,
        config: params.config,
        ...(params.agentId ? { agentId: params.agentId } : {}),
      })
    : undefined;
  // JSON status remains nonthrowing, but requested probe failures must stay visible.
  const health =
    params.deep && !params.gatewayStartupPhase
      ? !params.gatewayReachable
        ? { error: params.gatewayProbeError ?? "Gateway is unreachable" }
        : params.suppressHealthErrors
          ? await resolveGatewayHealthSummary({
              config: params.config,
              timeoutMs: params.timeoutMs,
              gatewayProbeDeadlineMs: params.gatewayProbeDeadlineMs,
            }).catch((error: unknown) => ({ error: String(error) }))
          : await resolveGatewayHealthSummary({
              config: params.config,
              timeoutMs: params.timeoutMs,
              gatewayProbeDeadlineMs: params.gatewayProbeDeadlineMs,
            })
      : undefined;
  // Last heartbeat is a deep-only gateway call; fast status should not spend network time here.
  const lastHeartbeat =
    params.deep && !params.gatewayStartupPhase
      ? await resolveStatusLastHeartbeat({
          config: params.config,
          timeoutMs: params.timeoutMs,
          gatewayProbeDeadlineMs: params.gatewayProbeDeadlineMs,
          gatewayReachable: params.gatewayReachable,
        })
      : null;
  const [gatewayService, nodeService] = await resolveStatusServiceSummaries(params.timeoutMs);
  return {
    securityAudit,
    usage,
    health,
    lastHeartbeat,
    gatewayService,
    nodeService,
  };
}
