import { isLoopbackIpAddress } from "@openclaw/net-policy/ip";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_GATEWAY_PORT, resolveGatewayPort } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { startSshPortForward, type SshTunnel } from "../infra/ssh-tunnel.js";
import type { GatewayConnectionDetails } from "./connection-details.js";
import { isGatewayWebSocketUrl } from "./net.js";
import { isGatewayRemoteSshTransport } from "./ssh-transport-config.js";

export type GatewaySshTunnelConnection = {
  url: string;
  urlSource: string;
  tunnel: SshTunnel;
  tlsServerName?: string;
};

const DEFAULT_SSH_TUNNEL_TIMEOUT_MS = 5_000;

function parseGatewayTunnelUrl(rawUrl: string): URL {
  if (!isGatewayWebSocketUrl(rawUrl)) {
    throw new Error(
      `Invalid Gateway URL for configured SSH transport: ${redactSensitiveUrlLikeString(rawUrl)}`,
    );
  }
  return new URL(rawUrl);
}

function parseExplicitUrlPort(url: URL): number | undefined {
  const port = Number(url.port);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function resolveRemoteSshPort(config: OpenClawConfig): number {
  const remotePort = config.gateway?.remote?.remotePort;
  return typeof remotePort === "number" &&
    Number.isInteger(remotePort) &&
    remotePort > 0 &&
    remotePort <= 65535
    ? remotePort
    : DEFAULT_GATEWAY_PORT;
}

function rewriteGatewayUrlToLocalTunnel(url: URL, rawUrl: string, localPort: number): string {
  const suffix =
    url.pathname === "/" && !rawUrl.includes("/", rawUrl.indexOf("//") + 2)
      ? `${url.search}${url.hash}`
      : `${url.pathname}${url.search}${url.hash}`;
  return `${url.protocol}//127.0.0.1:${localPort}${suffix}`;
}

function resolveGatewayTunnelTlsServerName(url: URL): string | undefined {
  if (url.protocol !== "wss:") {
    return undefined;
  }
  const hostname = normalizeOptionalString(url.hostname);
  if (!hostname) {
    return undefined;
  }
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isLoopbackTunnelUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    const unbracketed =
      hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    return unbracketed === "localhost" || isLoopbackIpAddress(unbracketed);
  } catch {
    return false;
  }
}

function shouldStartConfiguredSshTunnel(params: {
  config: OpenClawConfig;
  url: string;
  urlSource: string;
}): boolean {
  const remote = params.config.gateway?.remote;
  if (
    params.config.gateway?.mode !== "remote" ||
    !remote ||
    params.urlSource !== "config gateway.remote.url" ||
    !isGatewayRemoteSshTransport(remote)
  ) {
    return false;
  }
  return remote.transport === "ssh" || !isLoopbackTunnelUrl(params.url);
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

  const parsedUrl = parseGatewayTunnelUrl(params.url);
  const localPortPreferred = parseExplicitUrlPort(parsedUrl) ?? resolveGatewayPort(params.config);
  const remotePort = resolveRemoteSshPort(params.config);
  const identity = normalizeOptionalString(remote?.sshIdentity);
  const tunnel = await startSshPortForward({
    target,
    identity,
    hostKeyPolicy: remote?.sshHostKeyPolicy,
    localPortPreferred,
    remotePort,
    timeoutMs: DEFAULT_SSH_TUNNEL_TIMEOUT_MS,
  });
  const tlsServerName = resolveGatewayTunnelTlsServerName(parsedUrl);

  return {
    url: rewriteGatewayUrlToLocalTunnel(parsedUrl, params.url, tunnel.localPort),
    urlSource: `${params.urlSource} via ssh tunnel`,
    tunnel,
    ...(tlsServerName ? { tlsServerName } : {}),
  };
}

export function applyGatewaySshTunnelConnectionDetails(params: {
  details: GatewayConnectionDetails;
  ssh: GatewaySshTunnelConnection;
}): GatewayConnectionDetails {
  const detailLines = params.details.message
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("Gateway target:") &&
        !line.startsWith("Source:") &&
        !line.startsWith("Transport:"),
    );
  const message = [
    `Gateway target: ${redactSensitiveUrlLikeString(params.details.url)}`,
    `Source: ${params.details.urlSource}`,
    "Transport: configured SSH tunnel",
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
