import {
  type GatewayBonjourBeacon,
  pickResolvedGatewayHost,
  pickResolvedGatewayPort,
} from "../../infra/bonjour-discovery.js";
import { colorize, theme } from "../../terminal/theme.js";
import { parseTimeoutMsWithFallback } from "../parse-timeout.js";

export type GatewayDiscoverOpts = {
  timeout?: string;
  json?: boolean;
};

export function parseDiscoverTimeoutMs(raw: unknown, fallbackMs: number): number {
  return parseTimeoutMsWithFallback(raw, fallbackMs, { invalidType: "error" });
}

export function pickBeaconHost(beacon: GatewayBonjourBeacon): string | null {
  // Security: TXT records are unauthenticated. Prefer the resolved service endpoint (SRV/A/AAAA)
  // and fail closed when discovery did not resolve a routable host.
  return pickResolvedGatewayHost(beacon);
}

export function pickGatewayPort(beacon: GatewayBonjourBeacon): number | null {
  // Security: TXT records are unauthenticated. Prefer the resolved service port over TXT gatewayPort.
  // Fail closed when discovery did not resolve a routable port.
  return pickResolvedGatewayPort(beacon);
}

export function dedupeBeacons(beacons: GatewayBonjourBeacon[]): GatewayBonjourBeacon[] {
  const out: GatewayBonjourBeacon[] = [];
  const seen = new Set<string>();
  for (const b of beacons) {
    const host = pickBeaconHost(b) ?? "";
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
  const nameRaw = (beacon.displayName || beacon.instanceName || "Gateway").trim();
  const domainRaw = (beacon.domain || "local.").trim();

  const title = colorize(rich, theme.accentBright, nameRaw);
  const domain = colorize(rich, theme.muted, domainRaw);

  const host = pickBeaconHost(beacon);
  const gatewayPort = pickGatewayPort(beacon);
  const scheme = beacon.gatewayTls ? "wss" : "ws";
  const wsUrl = host && gatewayPort ? `${scheme}://${host}:${gatewayPort}` : null;

  const lines = [`- ${title} ${domain}`];

  if (beacon.tailnetDns) {
    lines.push(`  ${colorize(rich, theme.info, "tailnet")}: ${beacon.tailnetDns}`);
  }
  if (beacon.lanHost) {
    lines.push(`  ${colorize(rich, theme.info, "lan")}: ${beacon.lanHost}`);
  }
  if (beacon.host) {
    lines.push(`  ${colorize(rich, theme.info, "host")}: ${beacon.host}`);
  }

  if (wsUrl) {
    lines.push(`  ${colorize(rich, theme.muted, "ws")}: ${colorize(rich, theme.command, wsUrl)}`);
  }
  if (beacon.role) {
    lines.push(`  ${colorize(rich, theme.muted, "role")}: ${beacon.role}`);
  }
  if (beacon.transport) {
    lines.push(`  ${colorize(rich, theme.muted, "transport")}: ${beacon.transport}`);
  }
  if (beacon.gatewayTls) {
    const fingerprint = beacon.gatewayTlsFingerprintSha256
      ? `sha256 ${beacon.gatewayTlsFingerprintSha256}`
      : "enabled";
    lines.push(`  ${colorize(rich, theme.muted, "tls")}: ${fingerprint}`);
  }
  if (typeof beacon.sshPort === "number" && beacon.sshPort > 0 && host) {
    const ssh = `ssh -N -L 18789:127.0.0.1:18789 <user>@${host} -p ${beacon.sshPort}`;
    lines.push(`  ${colorize(rich, theme.muted, "ssh")}: ${colorize(rich, theme.command, ssh)}`);
  }
  return lines;
}
