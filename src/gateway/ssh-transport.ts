import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGatewayPort } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { startSshPortForward, type SshTunnel } from "../infra/ssh-tunnel.js";
import type { GatewayConnectionDetails } from "./connection-details.js";

export type GatewaySshTunnelConnection = {
  url: string;
  urlSource: string;
  tunnel: SshTunnel;
};

const DEFAULT_SSH_TUNNEL_TIMEOUT_MS = 5_000;

function parseExplicitUrlPort(rawUrl: string): number | undefined {
  try {
    const port = Number(new URL(rawUrl).port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

function resolveRemoteSshPort(config: OpenClawConfig, fallbackPort: number): number {
  const remotePort = config.gateway?.remote?.remotePort;
  return typeof remotePort === "number" && Number.isInteger(remotePort) && remotePort > 0
    ? remotePort
    : fallbackPort;
}

function rewriteGatewayUrlToLocalTunnel(rawUrl: string, localPort: number): string {
  try {
    const url = new URL(rawUrl);
    const suffix =
      url.pathname === "/" && !rawUrl.includes("/", rawUrl.indexOf("//") + 2)
        ? `${url.search}${url.hash}`
        : `${url.pathname}${url.search}${url.hash}`;
    return `${url.protocol}//127.0.0.1:${localPort}${suffix}`;
  } catch {
    return `ws://127.0.0.1:${localPort}`;
  }
}

function shouldStartConfiguredSshTunnel(params: {
  config: OpenClawConfig;
  urlSource: string;
}): boolean {
  return (
    params.config.gateway?.mode === "remote" &&
    params.config.gateway.remote?.transport === "ssh" &&
    params.urlSource === "config gateway.remote.url"
  );
}

export async function startGatewayRemoteSshTunnel(params: {
  config: OpenClawConfig;
  url: string;
  urlSource: string;
}): Promise<GatewaySshTunnelConnection | null> {
  if (!shouldStartConfiguredSshTunnel(params)) {
    return null;
  }

  const remote = params.config.gateway?.remote;
  const target = normalizeOptionalString(remote?.sshTarget);
  if (!target) {
    return null;
  }

  const localPortPreferred = parseExplicitUrlPort(params.url) ?? resolveGatewayPort(params.config);
  const remotePort = resolveRemoteSshPort(params.config, localPortPreferred);
  const tunnel = await startSshPortForward({
    target,
    identity: normalizeOptionalString(remote?.sshIdentity),
    localPortPreferred,
    remotePort,
    timeoutMs: DEFAULT_SSH_TUNNEL_TIMEOUT_MS,
  });

  return {
    url: rewriteGatewayUrlToLocalTunnel(params.url, tunnel.localPort),
    urlSource: `${params.urlSource} via ssh tunnel`,
    tunnel,
  };
}

export function applyGatewaySshTunnelConnectionDetails(params: {
  details: GatewayConnectionDetails;
  ssh: GatewaySshTunnelConnection;
}): GatewayConnectionDetails {
  const detailLines = params.details.message
    .split("\n")
    .filter((line) => !line.startsWith("Gateway target:") && !line.startsWith("Source:"));
  const message = [
    `Gateway target: ${redactSensitiveUrlLikeString(params.ssh.url)}`,
    `Source: ${params.ssh.urlSource}`,
    ...detailLines,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    ...params.details,
    url: params.ssh.url,
    urlSource: params.ssh.urlSource,
    message,
  };
}
