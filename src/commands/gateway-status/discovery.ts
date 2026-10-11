import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayBonjourBeacon } from "../../infra/bonjour-discovery.js";
import {
  buildGatewayDiscoveryTarget,
  serializeGatewayDiscoveryBeacon,
} from "../../infra/gateway-discovery-targets.js";

export function inferSshTargetFromRemoteUrl(rawUrl?: string | null): string | null {
  const trimmed = normalizeOptionalString(rawUrl);
  if (!trimmed) {
    return null;
  }
  const host = URL.parse(trimmed)?.hostname;
  return host ? buildSshTarget({ user: process.env.USER, host }) : null;
}

function buildSshTarget(input: { user?: string; host?: string; port?: number }): string | null {
  const host = normalizeOptionalString(input.host) ?? "";
  if (!host) {
    return null;
  }
  const user = normalizeOptionalString(input.user) ?? "";
  const base = user ? `${user}@${host}` : host;
  const port = input.port ?? 22;
  if (port && port !== 22) {
    return `${base}:${port}`;
  }
  return base;
}

/** Resolves an SSH target through ssh-config while preserving explicit identity choices. */
export async function resolveSshTarget(params: {
  rawTarget: string;
  identity: string | null;
  overallTimeoutMs: number;
}): Promise<{ target: string; identity?: string } | null> {
  const [{ resolveSshConfig }, { parseSshTarget }] = await Promise.all([
    import("../../infra/ssh-config.js"),
    import("../../infra/ssh-tunnel.js"),
  ]);
  const parsed = parseSshTarget(params.rawTarget);
  if (!parsed) {
    return null;
  }
  const config = await resolveSshConfig(parsed, {
    identity: params.identity ?? undefined,
    timeoutMs: Math.min(800, params.overallTimeoutMs),
  });
  if (!config) {
    return { target: params.rawTarget, identity: params.identity ?? undefined };
  }
  const target = buildSshTarget({
    user: config.user ?? parsed.user,
    host: config.host ?? parsed.host,
    port: config.port ?? parsed.port,
  });
  if (!target) {
    return { target: params.rawTarget, identity: params.identity ?? undefined };
  }
  const identityFile =
    params.identity ??
    config.identityFiles.find((entry) => normalizeOptionalString(entry)) ??
    undefined;
  return { target, identity: identityFile };
}

export function pickAutoSshTargetFromDiscovery(params: {
  discovery: GatewayBonjourBeacon[];
  parseSshTarget: (target: string) => unknown;
  sshUser?: string | null;
}): string | null {
  for (const beacon of params.discovery) {
    const sshTarget = buildGatewayDiscoveryTarget(beacon, {
      sshUser: params.sshUser ?? undefined,
    }).sshTarget;
    if (!sshTarget) {
      continue;
    }
    if (params.parseSshTarget(sshTarget)) {
      return sshTarget;
    }
  }
  return null;
}

export { serializeGatewayDiscoveryBeacon };
