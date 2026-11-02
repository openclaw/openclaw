import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
// Gateway discovery rendering helpers for Bonjour and wide-area DNS beacon output.
import { colorize, theme } from "../../../packages/terminal-core/src/theme.js";
import {
  resolveGatewayDiscoveryEndpoint,
  type GatewayBonjourBeacon,
} from "../../infra/bonjour-discovery.js";
import { buildGatewayDiscoveryTarget } from "../../infra/gateway-discovery-targets.js";

export type GatewayDiscoverOpts = {
  timeout?: string;
  json?: boolean;
};

export function dedupeBeacons(beacons: GatewayBonjourBeacon[]): GatewayBonjourBeacon[] {
  // Use display and endpoint fields; Bonjour can surface the same gateway on multiple interfaces.
  const out: GatewayBonjourBeacon[] = [];
  const seen = new Set<string>();
  for (const b of beacons) {
    const host = resolveGatewayDiscoveryEndpoint(b)?.host ?? "";
    const key = [
      b.domain ?? "",
      b.instanceName ?? "",
      b.displayName ?? "",
      host,
      String(b.port ?? ""),
      String(b.gatewayPort ?? ""),
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(b);
  }
  return out;
}

export function renderBeaconLines(beacon: GatewayBonjourBeacon, rich: boolean): string[] {
  const target = buildGatewayDiscoveryTarget(beacon);
  const title = colorize(rich, theme.accentBright, sanitizeTerminalText(target.title));
  const domain = colorize(rich, theme.muted, sanitizeTerminalText(target.domain));

  const lines = [`- ${title} ${domain}`];

  if (beacon.tailnetDns) {
    lines.push(
      `  ${colorize(rich, theme.info, "tailnet")}: ${sanitizeTerminalText(beacon.tailnetDns)}`,
    );
  }
  if (beacon.lanHost) {
    lines.push(`  ${colorize(rich, theme.info, "lan")}: ${sanitizeTerminalText(beacon.lanHost)}`);
  }
  if (beacon.host) {
    lines.push(`  ${colorize(rich, theme.info, "host")}: ${sanitizeTerminalText(beacon.host)}`);
  }

  if (target.wsUrl) {
    lines.push(
      `  ${colorize(rich, theme.muted, "ws")}: ${colorize(rich, theme.command, sanitizeTerminalText(target.wsUrl))}`,
    );
  }
  if (beacon.role) {
    lines.push(`  ${colorize(rich, theme.muted, "role")}: ${sanitizeTerminalText(beacon.role)}`);
  }
  if (beacon.transport) {
    lines.push(
      `  ${colorize(rich, theme.muted, "transport")}: ${sanitizeTerminalText(beacon.transport)}`,
    );
  }
  if (beacon.gatewayTls) {
    const fingerprint = beacon.gatewayTlsFingerprintSha256
      ? `sha256 ${beacon.gatewayTlsFingerprintSha256}`
      : "enabled";
    lines.push(`  ${colorize(rich, theme.muted, "tls")}: ${sanitizeTerminalText(fingerprint)}`);
  }
  if (target.endpoint && target.sshPort) {
    const ssh = `ssh -N -L 18789:127.0.0.1:${target.endpoint.port} <user>@${target.endpoint.host} -p ${target.sshPort}`;
    lines.push(
      `  ${colorize(rich, theme.muted, "ssh")}: ${colorize(rich, theme.command, sanitizeTerminalText(ssh))}`,
    );
  }
  return lines;
}
