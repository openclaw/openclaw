import http2 from "node:http2";
import tls from "node:tls";
import { openHttpConnectTunnel } from "./net/http-connect-tunnel.js";
import { getActiveManagedProxyUrl } from "./net/proxy/active-proxy-state.js";

const APNS_AUTHORITIES = new Set([
  "https://api.push.apple.com",
  "https://api.sandbox.push.apple.com",
]);

type ApnsAuthority = "https://api.push.apple.com" | "https://api.sandbox.push.apple.com";

export type ConnectApnsHttp2SessionParams = {
  authority: string;
  timeoutMs: number;
};

function assertApnsAuthority(authority: string): ApnsAuthority {
  let parsed: URL;
  try {
    parsed = new URL(authority);
  } catch {
    throw new Error(`Unsupported APNs authority: ${authority}`);
  }
  const normalized = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  if (!APNS_AUTHORITIES.has(normalized)) {
    throw new Error(`Unsupported APNs authority: ${authority}`);
  }
  return normalized as ApnsAuthority;
}

export async function connectApnsHttp2Session(
  params: ConnectApnsHttp2SessionParams,
): Promise<http2.ClientHttp2Session> {
  const authority = assertApnsAuthority(params.authority);
  const proxyUrl = getActiveManagedProxyUrl();
  if (!proxyUrl) {
    return http2.connect(authority);
  }

  const apnsHost = new URL(authority).hostname;
  const tunnel = await openHttpConnectTunnel({
    proxyUrl,
    targetHost: apnsHost,
    targetPort: 443,
    timeoutMs: params.timeoutMs,
  });
  const tlsSocket = tls.connect({
    socket: tunnel,
    servername: apnsHost,
    ALPNProtocols: ["h2"],
  });

  return http2.connect(authority, {
    createConnection: () => tlsSocket,
  });
}
