import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  isProbeReachable,
  isPostConnectProbeFailure,
  isScopeLimitedProbeFailure,
} from "./helpers.js";
import type { GatewayStatusProbedTarget } from "./probe-run.js";

type GatewayStatusWarning = {
  code: string;
  message: string;
  targetIds?: string[];
};

const noReachableGatewayDiagnostic =
  "No gateway answered any check and Bonjour discovery returned no local gateways. Run `openclaw gateway status --deep --require-rpc` to inspect service state, config paths, listener owners, and logs; include `ss -ltnp` or `lsof -nP -iTCP:<port> -sTCP:LISTEN` for the configured port when filing a report.";

function gatewaySelfIdentityKey(entry: GatewayStatusProbedTarget): string | null {
  if (!entry.self) {
    return null;
  }
  const host = normalizeLowercaseStringOrEmpty(entry.self.host);
  const ip = normalizeLowercaseStringOrEmpty(entry.self.ip);
  const instanceId = normalizeLowercaseStringOrEmpty(entry.self.instanceId);
  const deviceId = normalizeLowercaseStringOrEmpty(entry.self.deviceId);
  const discriminator = instanceId
    ? `instance:${instanceId}`
    : deviceId
      ? `device:${deviceId}`
      : "";
  if ((!host && !ip) || !discriminator) {
    return null;
  }
  return `${host}\0${ip}\0${discriminator}`;
}

function hasMultipleReachableGatewayIdentities(reachable: GatewayStatusProbedTarget[]): boolean {
  if (reachable.length <= 1) {
    return false;
  }
  const identityKeys = reachable.map(gatewaySelfIdentityKey);
  if (identityKeys.some((key) => key === null)) {
    return true;
  }
  return new Set(identityKeys).size > 1;
}

export function pickPrimaryProbedTarget(probed: GatewayStatusProbedTarget[]) {
  const reachable = probed.filter((entry) => isProbeReachable(entry.probe));
  return (
    reachable.find((entry) => entry.target.kind === "explicit") ??
    reachable.find((entry) => entry.target.kind === "sshTunnel") ??
    reachable.find((entry) => entry.target.kind === "configRemote") ??
    reachable.find((entry) => entry.target.kind === "localLoopback") ??
    null
  );
}

export function buildGatewayStatusWarnings(params: {
  probed: GatewayStatusProbedTarget[];
  sshTarget: string | null;
  sshTunnelStarted: boolean;
  sshTunnelError: string | null;
  localTlsLoadError?: string | null;
  discoveryCount?: number;
}): GatewayStatusWarning[] {
  const reachable = params.probed.filter((entry) => isProbeReachable(entry.probe));
  const degradedScopeLimited = params.probed.filter((entry) =>
    isScopeLimitedProbeFailure(entry.probe),
  );
  const degradedDetailFailed = params.probed.filter(
    (entry) => isPostConnectProbeFailure(entry.probe) && !isScopeLimitedProbeFailure(entry.probe),
  );
  const warnings: GatewayStatusWarning[] = [];
  if (params.sshTarget && !params.sshTunnelStarted) {
    warnings.push({
      code: "ssh_tunnel_failed",
      message: params.sshTunnelError
        ? `SSH tunnel failed: ${params.sshTunnelError}`
        : "SSH tunnel failed to start; falling back to direct checks.",
    });
  }
  if (params.localTlsLoadError) {
    warnings.push({
      code: "local_tls_runtime_unavailable",
      message: `Local gateway TLS is enabled but OpenClaw could not load the local certificate fingerprint: ${params.localTlsLoadError}`,
      targetIds: ["localLoopback"],
    });
  }
  if (reachable.length === 0 && params.discoveryCount === 0) {
    warnings.push({
      code: "no_gateway_reachable",
      message: noReachableGatewayDiagnostic,
      targetIds: params.probed.map((entry) => entry.target.id),
    });
  }
  if (hasMultipleReachableGatewayIdentities(reachable)) {
    // Multiple reachable gateways are valid for isolated profiles but surprising
    // enough to call out before users debug against the wrong process.
    warnings.push({
      code: "multiple_gateways",
      message:
        "Unconventional setup: multiple reachable gateway identities detected. Usually one gateway per network is recommended unless you intentionally run isolated profiles, like a rescue bot (see docs: /gateway#multiple-gateways-same-host).",
      targetIds: reachable.map((entry) => entry.target.id),
    });
  }
  for (const result of params.probed) {
    if (result.authDiagnostics.length === 0 || isProbeReachable(result.probe)) {
      continue;
    }
    for (const diagnostic of result.authDiagnostics) {
      warnings.push({
        code: "auth_secretref_unresolved",
        message: diagnostic,
        targetIds: [result.target.id],
      });
    }
  }
  for (const result of degradedScopeLimited) {
    warnings.push({
      code: "probe_scope_limited",
      message:
        "Read-check diagnostics are limited by gateway scopes (missing operator.read). Connection succeeded, but read-only status calls are incomplete. Hint: pair device identity or use credentials with operator.read.",
      targetIds: [result.target.id],
    });
  }
  for (const result of degradedDetailFailed) {
    const detail = result.probe.error ? `: ${result.probe.error}` : ".";
    warnings.push({
      code: "probe_detail_failed",
      message: `Gateway accepted the WebSocket connection, but follow-up read diagnostics failed${detail}`,
      targetIds: [result.target.id],
    });
  }
  return warnings;
}
