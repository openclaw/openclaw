// Heavy modules stay lazily loaded so fast status output avoids security/provider/gateway costs.

import type { Result } from "@openclaw/normalization-core/result";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatGatewayServiceInstallationDrift } from "../cli/daemon-cli/shared.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveNodeService } from "../daemon/node-service.js";
import { OPENCLAW_WRAPPER_ENV_KEY } from "../daemon/program-args.js";
import { formatServiceLabel } from "../daemon/runtime-format.js";
import {
  inspectGatewayServiceInstallationDrift,
  summarizeGatewayServiceLayout,
  type GatewayServiceLayoutSummary,
} from "../daemon/service-layout.js";
import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import type { GatewayServiceLoadState } from "../daemon/service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "../daemon/service.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import type { RuntimeEnv } from "../runtime.js";
import type { HealthSummary } from "./health.js";
import type { StatusUsageSummaryOptions } from "./status-usage.runtime.js";
import { formatDaemonRuntimeShort } from "./status.format.js";
import { resolveStatusGatewayProbeTimeoutMs } from "./status.gateway-probe-budget.js";

/** Runs the lightweight security audit used by status JSON/all output. */
export async function resolveStatusSecurityAudit(params: {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  timeoutMs?: number;
}) {
  const { runSecurityAudit } = await import("../security/audit.runtime.js");
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
  return (await import("./status-usage.runtime.js")).resolveStatusUsageSummary(params);
}

type StatusGatewayQuery = {
  config: OpenClawConfig;
  timeoutMs?: number;
  gatewayProbeDeadlineMs: number;
  callOverrides?: { url: string; token?: string; password?: string };
};
type StatusGatewayFailure = { kind: "budget" } | { kind: "request"; cause: unknown };

async function queryStatusGateway<T>(
  params: StatusGatewayQuery,
  buildRequest: () => Pick<CallGatewayOptions, "method" | "params">,
): Promise<Result<T, StatusGatewayFailure>> {
  const { callGateway } = await import("../gateway/call.js");
  const timeoutMs = resolveStatusGatewayProbeTimeoutMs(params);
  if (timeoutMs === 0) {
    return { ok: false, error: { kind: "budget" } };
  }
  // Import failures still propagate; only an attempted RPC becomes a request failure.
  return await callGateway<T>({
    ...buildRequest(),
    timeoutMs,
    config: params.config,
    ...params.callOverrides,
  }).then<Result<T, StatusGatewayFailure>, Result<T, StatusGatewayFailure>>(
    (value) => ({ ok: true, value }),
    (cause: unknown) => ({ ok: false, error: { kind: "request", cause } }),
  );
}

function formatStatusGatewayFailure(error: StatusGatewayFailure, operation: string): string {
  return error.kind === "budget"
    ? `Gateway check budget exhausted before ${operation}.`
    : String(error.cause);
}

/** Calls gateway health and lets errors propagate to deep status callers. */
export async function resolveStatusGatewayHealth(
  params: Omit<StatusGatewayQuery, "callOverrides">,
) {
  const result = await queryStatusGateway<HealthSummary>(params, () => ({
    method: "health",
    params: { probe: true },
  }));
  if (!result.ok) {
    throw result.error.kind === "request"
      ? result.error.cause
      : new Error(formatStatusGatewayFailure(result.error, "health check"));
  }
  return result.value;
}

/** Calls gateway health but converts unreachable/failing probes into an error object. */
export async function resolveStatusGatewayHealthSafe(
  params: StatusGatewayQuery & { gatewayReachable: boolean; gatewayProbeError?: string | null },
) {
  if (!params.gatewayReachable) {
    return { error: params.gatewayProbeError ?? "gateway unreachable" };
  }
  const result = await queryStatusGateway<HealthSummary>(params, () => ({
    method: "health",
    params: { probe: true },
  }));
  return result.ok
    ? result.value
    : { error: formatStatusGatewayFailure(result.error, "health check") };
}

export type StatusGatewayDiagnosticsResult = Result<unknown, string>;

/** Reads gateway diagnostics while preserving whether data or an unavailable outcome was observed. */
export async function resolveStatusGatewayDiagnosticsSafe(
  params: StatusGatewayQuery & { gatewayReachable: boolean; type?: string },
): Promise<StatusGatewayDiagnosticsResult> {
  if (!params.gatewayReachable) {
    return { ok: false, error: "gateway unreachable" };
  }
  const result = await queryStatusGateway<unknown>(params, () => ({
    method: "diagnostics.stability",
    params: { limit: 1000, ...(params.type ? { type: params.type } : {}) },
  }));
  return result.ok
    ? result
    : { ok: false, error: formatStatusGatewayFailure(result.error, "diagnostics") };
}

/** Reads the most recent gateway heartbeat only when the gateway probe succeeded. */
async function resolveStatusLastHeartbeat(
  params: Omit<StatusGatewayQuery, "callOverrides"> & { gatewayReachable: boolean },
) {
  if (!params.gatewayReachable) {
    return null;
  }
  const result = await queryStatusGateway<HeartbeatEventPayload | null>(params, () => ({
    method: "last-heartbeat",
    params: {},
  }));
  return result.ok ? result.value : null;
}

// Default bound for service-manager probes when status runs without an explicit
// --timeout, so a wedged systemd/launchd socket cannot hang `openclaw status`.
const DEFAULT_SERVICE_PROBE_TIMEOUT_MS = 5000;

type ServiceStatusSummary = {
  label: string;
  installed: boolean | null;
  loadState: GatewayServiceLoadState;
  managedByOpenClaw: boolean;
  externallyManaged: boolean;
  loadedText: string;
  runtime: GatewayServiceRuntime | undefined;
  layout?: GatewayServiceLayoutSummary;
  wrapperPath?: string;
  installationDrift?: string;
};

async function buildDaemonStatusSummary(serviceLabel: "gateway" | "node", timeoutMs?: number) {
  const service = serviceLabel === "gateway" ? resolveGatewayService() : resolveNodeService();
  const fallbackLabel = serviceLabel === "gateway" ? "Daemon" : "Node";
  const activePackageRoot =
    serviceLabel === "gateway"
      ? await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url, argv1: process.argv[1] })
      : null;
  let summary: ServiceStatusSummary;
  try {
    const state = await readGatewayServiceState(service, { env: process.env, timeoutMs });
    // Layout is optional enrichment; a broken manifest or inaccessible path
    // must not erase service-manager evidence that the gateway is running.
    const layout = await summarizeGatewayServiceLayout(state.command).catch(() => undefined);
    const installationDrift = activePackageRoot
      ? await inspectGatewayServiceInstallationDrift(layout, activePackageRoot).catch(
          () => undefined,
        )
      : undefined;
    const wrapperPath = state.command?.environment?.[OPENCLAW_WRAPPER_ENV_KEY]?.trim();
    const managedByOpenClaw = state.installed;
    // A running unmanaged process still counts as installed for status display.
    const externallyManaged = !managedByOpenClaw && state.running;
    const installed = managedByOpenClaw || externallyManaged;
    const loadedText = externallyManaged
      ? "running (externally managed)"
      : state.loadState.status === "loaded"
        ? service.loadedText
        : state.loadState.status === "not-loaded"
          ? service.notLoadedText
          : "unknown";
    summary = {
      label: formatServiceLabel(service.label, state.runtime),
      installed,
      loadState: state.loadState,
      managedByOpenClaw,
      externallyManaged,
      loadedText,
      runtime: state.runtime,
      ...(layout ? { layout } : {}),
      ...(wrapperPath ? { wrapperPath } : {}),
      ...(installationDrift
        ? {
            installationDrift: formatGatewayServiceInstallationDrift(
              installationDrift,
              undefined,
              state.env,
            ),
          }
        : {}),
    };
  } catch (error) {
    // Status output should survive service-manager errors and show an unknown row.
    summary = {
      label: fallbackLabel,
      installed: null,
      loadState: { status: "unknown", detail: String(error) },
      managedByOpenClaw: false,
      externallyManaged: false,
      loadedText: "unknown",
      runtime: undefined,
    };
  }
  const runtime = summary.runtime?.inspectionFailure
    ? { ...summary.runtime, detail: `${summary.runtime.detail}; retry with openclaw status --deep` }
    : summary.runtime;
  const loaded =
    summary.loadState.status === "unknown" ? null : summary.loadState.status === "loaded";
  return {
    ...summary,
    loaded,
    runtime,
    runtimeShort: formatDaemonRuntimeShort(runtime),
  };
}

/** Preserve independent service diagnostics when local status collection refuses state. */
export async function reportStatusScanFailure(
  error: unknown,
  runtime: RuntimeEnv,
  timeoutMs?: number,
): Promise<never> {
  try {
    const { installationDrift } = await buildDaemonStatusSummary(
      "gateway",
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
    buildDaemonStatusSummary("gateway", probeTimeoutMs),
    buildDaemonStatusSummary("node", probeTimeoutMs),
  ]);
}

type StatusUsageSummary = Awaited<ReturnType<typeof resolveStatusUsageSummary>>;
type StatusGatewayHealth = Awaited<ReturnType<typeof resolveStatusGatewayHealth>>;
type StatusSecurityAudit = Awaited<ReturnType<typeof resolveStatusSecurityAudit>>;

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
        : await resolveGatewayHealthSummary({
            config: params.config,
            timeoutMs: params.timeoutMs,
            gatewayProbeDeadlineMs: params.gatewayProbeDeadlineMs,
          }).catch(
            params.suppressHealthErrors
              ? (error: unknown) => ({ error: String(error) })
              : undefined,
          )
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
