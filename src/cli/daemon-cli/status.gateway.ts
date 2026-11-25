import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveGatewayPort } from "../../config/paths.js";
import type { GatewayBindMode, OpenClawConfig } from "../../config/types.js";
import { projectGatewayUrlForDiagnostics } from "../../gateway/connection-details.js";
import { resolveAdvertisedControlUiLinks } from "../../gateway/control-ui-links.js";
import { trimToUndefined } from "../../gateway/credentials.js";
import { resolveGatewayBindHost, resolveGatewayRequiredListenHosts } from "../../gateway/net.js";
import { inspectPortUsage, inspectPortUsages } from "../../infra/ports-inspect.js";
import type { PortUsage } from "../../infra/ports-types.js";
import { parseTcpPortFromArgs } from "../../infra/tcp-port.js";
import type { WindowsGatewayFirewallDiagnostic } from "../../infra/windows-gateway-firewall-diagnostics.js";

type GatewayStatusSummary = {
  bindMode: GatewayBindMode;
  bindHost: string;
  customBindHost?: string;
  tlsEnabled?: boolean;
  port: number;
  portSource: "cli" | "service args" | "env/config";
  probeUrl: string;
  controlUiLinks?: { httpUrl: string; wsUrl: string };
  probeNote?: string;
  version?: string | null;
  windowsFirewall?: WindowsGatewayFirewallDiagnostic;
};

type PortStatusSummary = Pick<PortUsage, "port" | "status" | "listeners" | "hints">;

export async function resolveGatewayStatusSummary(params: {
  daemonCfg: OpenClawConfig;
  cliCfg: OpenClawConfig;
  mergedDaemonEnv: Record<string, string | undefined>;
  commandProgramArguments?: string[];
  rpcUrlOverride?: string;
  localPortOverride?: number;
}) {
  const portFromArgs = parseTcpPortFromArgs(params.commandProgramArguments);
  const daemonPort =
    params.localPortOverride ??
    portFromArgs ??
    resolveGatewayPort(params.daemonCfg, params.mergedDaemonEnv);
  const portSource: GatewayStatusSummary["portSource"] =
    params.localPortOverride !== undefined ? "cli" : portFromArgs ? "service args" : "env/config";
  const bindMode: GatewayBindMode = params.daemonCfg.gateway?.bind ?? "loopback";
  const customBindHost = params.daemonCfg.gateway?.customBindHost;
  let bindHost: string;
  let bindHostWarning: string | undefined;
  try {
    bindHost = await resolveGatewayBindHost(bindMode, customBindHost);
  } catch (error) {
    bindHost =
      bindMode === "lan"
        ? "0.0.0.0"
        : bindMode === "custom"
          ? customBindHost?.trim() || "0.0.0.0"
          : "127.0.0.1";
    const message = error instanceof Error ? error.message.trim() : "";
    bindHostWarning = `Status is using fallback network details because interface discovery failed: ${message || "network interface discovery failed"}.`;
  }
  // The local CLI uses loopback; custom and Tailnet binds also require that listener.
  const probeHost = "127.0.0.1";
  const probeUrlOverride = trimToUndefined(params.rpcUrlOverride) ?? null;
  const tlsEnabled = params.daemonCfg.gateway?.tls?.enabled === true;
  const scheme = tlsEnabled ? "wss" : "ws";
  const probeUrl = probeUrlOverride ?? `${scheme}://${probeHost}:${daemonPort}`;
  const diagnosticProbeUrl = projectGatewayUrlForDiagnostics(probeUrl);
  const controlUiLinks =
    params.daemonCfg.gateway?.controlUi?.enabled === false
      ? undefined
      : await resolveAdvertisedControlUiLinks({
          port: daemonPort,
          bind: bindMode,
          customBindHost,
          basePath: params.daemonCfg.gateway?.controlUi?.basePath,
          tlsEnabled,
        });
  const bindNote =
    !probeUrlOverride && bindMode === "lan"
      ? `bind=lan listens on 0.0.0.0 (all interfaces); checking via ${probeHost}.`
      : !probeUrlOverride && bindMode === "loopback"
        ? "Loopback-only gateway; only local clients can connect."
        : undefined;
  const probeNote = uniqueStrings(
    [bindNote, bindHostWarning].filter((value): value is string => Boolean(value?.trim())),
  ).join(" ");

  const gateway: GatewayStatusSummary = {
    bindMode,
    bindHost,
    customBindHost,
    ...(tlsEnabled ? { tlsEnabled } : {}),
    port: daemonPort,
    portSource,
    probeUrl: diagnosticProbeUrl,
    ...(controlUiLinks ? { controlUiLinks } : {}),
    ...(probeNote ? { probeNote } : {}),
  };
  return {
    gateway,
    daemonPort,
    cliPort: resolveGatewayPort(params.cliCfg, process.env),
    probeUrl,
    probeUrlOverride,
  };
}

function toPortStatusSummary(
  diagnostics: Awaited<ReturnType<typeof inspectPortUsage>> | null,
): PortStatusSummary | undefined {
  if (!diagnostics) {
    return undefined;
  }
  return {
    port: diagnostics.port,
    status: diagnostics.status,
    listeners: diagnostics.listeners,
    hints: diagnostics.hints,
  };
}

export async function inspectDaemonPortStatuses(params: {
  daemonPort: number;
  cliPort: number;
  daemonBindHost: string;
}): Promise<{ portStatus?: PortStatusSummary; portCliStatus?: PortStatusSummary }> {
  const daemonProbeHosts = resolveGatewayRequiredListenHosts(params.daemonBindHost);
  if (params.cliPort === params.daemonPort) {
    const portDiagnostics = await inspectPortUsage(params.daemonPort, {
      probeHosts: daemonProbeHosts,
    }).catch(() => null);
    return {
      portStatus: toPortStatusSummary(portDiagnostics),
      portCliStatus: undefined,
    };
  }
  const portDiagnosticsByPort = await inspectPortUsages([params.daemonPort, params.cliPort], {
    probeHostsByPort: new Map([[params.daemonPort, daemonProbeHosts]]),
  }).catch(() => new Map());
  return {
    portStatus: toPortStatusSummary(portDiagnosticsByPort.get(params.daemonPort) ?? null),
    portCliStatus: toPortStatusSummary(portDiagnosticsByPort.get(params.cliPort) ?? null),
  };
}
