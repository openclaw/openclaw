import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { colorize, theme } from "../../../packages/terminal-core/src/theme.js";
import {
  resolveGatewayDiscoveryEndpoint,
  type GatewayBonjourBeacon,
} from "../../infra/bonjour-discovery.js";
import { buildGatewayDiscoveryTarget } from "../../infra/gateway-discovery-targets.js";
import { dedupeByKey } from "../../shared/dedupe-by-key.js";

export type GatewayDiscoverOpts = {
  timeout?: string;
  json?: boolean;
};

export function dedupeBeacons(beacons: GatewayBonjourBeacon[]): GatewayBonjourBeacon[] {
  // Use display and endpoint fields; Bonjour can surface the same gateway on multiple interfaces.
  return dedupeByKey(beacons, (b) => {
    const host = resolveGatewayDiscoveryEndpoint(b)?.host ?? "";
    return [
      b.domain ?? "",
      b.instanceName ?? "",
      b.displayName ?? "",
      host,
      String(b.port ?? ""),
      String(b.gatewayPort ?? ""),
    ].join("|");
  });
}

export function renderBeaconLines(beacon: GatewayBonjourBeacon, rich: boolean): string[] {
  const target = buildGatewayDiscoveryTarget(beacon);
  const title = colorize(rich, theme.accentBright, sanitizeTerminalText(target.title));
  const domain = colorize(rich, theme.muted, sanitizeTerminalText(target.domain));

  const lines = [`- ${title} ${domain}`];

  for (const [label, value] of [
    ["tailnet", beacon.tailnetDns],
    ["lan", beacon.lanHost],
    ["host", beacon.host],
  ] as const) {
    if (value) {
      lines.push(`  ${colorize(rich, theme.info, label)}: ${sanitizeTerminalText(value)}`);
    }
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
