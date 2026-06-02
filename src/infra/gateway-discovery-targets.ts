import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveGatewayDiscoveryEndpoint,
  type GatewayBonjourBeacon,
  type GatewayDiscoveryResolvedEndpoint,
} from "./bonjour-discovery.js";

/** Canonical target shape shared by discovery CLI, remote onboarding, and status output. */
type GatewayDiscoveryTarget = {
  title: string;
  domain: string;
  endpoint: GatewayDiscoveryResolvedEndpoint | null;
  wsUrl: string | null;
  sshPort: number | null;
  sshTarget: string | null;
};

function pickSshPort(beacon: GatewayBonjourBeacon): number | null {
  return typeof beacon.sshPort === "number" && Number.isFinite(beacon.sshPort) && beacon.sshPort > 0
    ? beacon.sshPort
    : null;
}

/**
 * Resolve a Bonjour beacon into connection-ready Gateway URLs and optional SSH
 * target text. TXT-only metadata stays non-routable until endpoint resolution
 * proves a host/port, preventing status/onboarding from trusting hints alone.
 */
export function buildGatewayDiscoveryTarget(
  beacon: GatewayBonjourBeacon,
  opts?: { sshUser?: string | null },
): GatewayDiscoveryTarget {
  const endpoint = resolveGatewayDiscoveryEndpoint(beacon);
  const sshPort = pickSshPort(beacon);
  const sshUser = normalizeOptionalString(opts?.sshUser) ?? "";
  const baseSshTarget = endpoint ? (sshUser ? `${sshUser}@${endpoint.host}` : endpoint.host) : null;
  // Keep default SSH port implicit so copy/paste targets match normal ssh UX,
  // while non-standard Bonjour-advertised ports remain visible.
  const sshTarget =
    baseSshTarget && sshPort && sshPort !== 22 ? `${baseSshTarget}:${sshPort}` : baseSshTarget;
  return {
    title:
      normalizeOptionalString(beacon.displayName || beacon.instanceName || "Gateway") ?? "Gateway",
    domain: normalizeOptionalString(beacon.domain || "local.") ?? "local.",
    endpoint,
    wsUrl: endpoint?.wsUrl ?? null,
    sshPort,
    sshTarget,
  };
}

/** Build the interactive discovery label with a resolved host hint when available. */
export function buildGatewayDiscoveryLabel(beacon: GatewayBonjourBeacon): string {
  const target = buildGatewayDiscoveryTarget(beacon);
  const hint = target.endpoint ? `${target.endpoint.host}:${target.endpoint.port}` : "host unknown";
  return `${target.title} (${hint})`;
}

/**
 * Serialize discovery output for status JSON while reusing the same endpoint
 * resolution as human-facing labels and SSH auto-targets.
 */
export function serializeGatewayDiscoveryBeacon(beacon: GatewayBonjourBeacon) {
  const target = buildGatewayDiscoveryTarget(beacon);
  return {
    instanceName: beacon.instanceName,
    displayName: beacon.displayName ?? null,
    domain: beacon.domain ?? null,
    host: beacon.host ?? null,
    lanHost: beacon.lanHost ?? null,
    tailnetDns: beacon.tailnetDns ?? null,
    gatewayPort: beacon.gatewayPort ?? null,
    sshPort: beacon.sshPort ?? null,
    wsUrl: target.wsUrl,
  };
}
