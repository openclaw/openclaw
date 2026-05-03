import http2 from "node:http2";
import { openHttpConnectTunnel } from "./net/http-connect-tunnel.js";
import {
  getActiveManagedProxyUrl,
  type ActiveManagedProxyUrl,
} from "./net/proxy/active-proxy-state.js";

const APNS_AUTHORITIES = new Set([
  "https://api.push.apple.com",
  "https://api.sandbox.push.apple.com",
]);

type ApnsAuthority = "https://api.push.apple.com" | "https://api.sandbox.push.apple.com";

export const APNS_HTTP2_CANCEL_CODE = http2.constants.NGHTTP2_CANCEL;

export type ConnectApnsHttp2SessionParams = {
  authority: string;
  timeoutMs: number;
};

export type ProbeApnsHttp2ReachabilityViaProxyParams = {
  authority: string;
  proxyUrl: string;
  timeoutMs: number;
};

export type ProbeApnsHttp2ReachabilityViaProxyResult = {
  status: number;
  body: string;
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

async function openProxiedApnsHttp2Session(params: {
  authority: ApnsAuthority;
  proxyUrl: ActiveManagedProxyUrl;
  timeoutMs: number;
}): Promise<http2.ClientHttp2Session> {
  const apnsHost = new URL(params.authority).hostname;
  const tlsSocket = await openHttpConnectTunnel({
    proxyUrl: params.proxyUrl,
    targetHost: apnsHost,
    targetPort: 443,
    timeoutMs: params.timeoutMs,
  });

  return http2.connect(params.authority, {
    createConnection: () => tlsSocket,
  });
}

export async function connectApnsHttp2Session(
  params: ConnectApnsHttp2SessionParams,
): Promise<http2.ClientHttp2Session> {
  const authority = assertApnsAuthority(params.authority);
  const proxyUrl = getActiveManagedProxyUrl();
  if (!proxyUrl) {
    return http2.connect(authority);
  }

  return await openProxiedApnsHttp2Session({
    authority,
    proxyUrl,
    timeoutMs: params.timeoutMs,
  });
}

export async function probeApnsHttp2ReachabilityViaProxy(
  params: ProbeApnsHttp2ReachabilityViaProxyParams,
): Promise<ProbeApnsHttp2ReachabilityViaProxyResult> {
  const authority = assertApnsAuthority(params.authority);
  const session = await openProxiedApnsHttp2Session({
    authority,
    proxyUrl: new URL(params.proxyUrl),
    timeoutMs: params.timeoutMs,
  });

  try {
    return await new Promise<ProbeApnsHttp2ReachabilityViaProxyResult>((resolve, reject) => {
      let settled = false;
      let body = "";
      let status: number | undefined;
      const timeout = setTimeout(() => {
        fail(
          new Error(`APNs reachability probe timed out after ${Math.trunc(params.timeoutMs)}ms`),
        );
      }, Math.trunc(params.timeoutMs));
      timeout.unref?.();

      const cleanup = () => {
        clearTimeout(timeout);
        session.off("error", fail);
      };

      const fail = (err: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        session.destroy(err instanceof Error ? err : new Error(String(err)));
        reject(err);
      };

      const request = session.request({
        ":method": "POST",
        ":path": `/3/device/${"0".repeat(64)}`,
        authorization: "bearer intentionally.invalid.openclaw.proxy.validation",
        "apns-topic": "ai.openclaw.ios",
        "apns-push-type": "alert",
        "apns-priority": "10",
      });

      session.once("error", fail);
      request.setEncoding("utf8");
      request.on("response", (headers) => {
        const rawStatus = headers[":status"];
        status = typeof rawStatus === "number" ? rawStatus : Number(rawStatus);
      });
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.once("error", fail);
      request.once("end", () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (status === undefined || !Number.isFinite(status)) {
          reject(new Error("APNs reachability probe ended without an HTTP/2 status"));
          return;
        }
        resolve({ status, body });
      });
      request.end(JSON.stringify({ aps: { alert: "OpenClaw APNs proxy validation" } }));
    });
  } finally {
    if (!session.closed && !session.destroyed) {
      session.close();
    }
  }
}
