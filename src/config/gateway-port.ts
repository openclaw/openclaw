import { normalizeProfileName, resolveProfileGatewayPort } from "../cli/profile-utils.js";
import { parseTcpPort } from "../infra/tcp-port.js";
import type { OpenClawConfig } from "./types.js";

export const DEFAULT_GATEWAY_PORT = 18789;

export function parseGatewayPortEnvValue(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return parseTcpPort(trimmed);
  }

  // Docker Compose publish strings can leak into host CLI env loading via repo `.env`,
  // for example `127.0.0.1:18789` or `[::1]:18789`. Accept only explicit host:port forms.
  const bracketedIpv6Match = trimmed.match(/^\[[^\]]+\]:(\d+)$/);
  if (bracketedIpv6Match?.[1]) {
    return parseTcpPort(bracketedIpv6Match[1]);
  }

  const firstColon = trimmed.indexOf(":");
  const lastColon = trimmed.lastIndexOf(":");
  if (firstColon <= 0 || firstColon !== lastColon) {
    return null;
  }
  const suffix = trimmed.slice(firstColon + 1);
  if (!/^\d+$/.test(suffix)) {
    return null;
  }
  return parseTcpPort(suffix);
}

export function resolveGatewayPort(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envPort = parseGatewayPortEnvValue(env.OPENCLAW_GATEWAY_PORT);
  if (envPort !== null) {
    return envPort;
  }
  const configPort = cfg?.gateway?.port;
  if (typeof configPort === "number" && Number.isFinite(configPort) && configPort > 0) {
    return configPort;
  }
  const profile = normalizeProfileName(env.OPENCLAW_PROFILE);
  return profile ? resolveProfileGatewayPort(profile) : DEFAULT_GATEWAY_PORT;
}
