import { EventEmitter } from "node:events";
import type http from "node:http";
import type net from "node:net";
import { HttpsProxyAgent } from "https-proxy-agent";

export type HttpConnectTunnelParams = {
  proxyUrl: string;
  targetHost: string;
  targetPort: number;
  timeoutMs?: number;
};

function redactProxyUrl(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "<invalid proxy URL>";
  }
}

function isSuccessfulProxySocket(socket: net.Socket): boolean {
  return !socket.destroyed && socket.writable;
}

export async function openHttpConnectTunnel(params: HttpConnectTunnelParams): Promise<net.Socket> {
  const req = new EventEmitter() as http.ClientRequest;
  req.once = req.once.bind(req) as typeof req.once;
  req.emit = req.emit.bind(req) as typeof req.emit;

  const agent = new HttpsProxyAgent(params.proxyUrl, { keepAlive: true });
  let timeout: NodeJS.Timeout | undefined;
  const clear = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };

  try {
    if (params.timeoutMs && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0) {
      timeout = setTimeout(() => {
        req.emit(
          "error",
          new Error(`Proxy CONNECT timed out after ${Math.trunc(params.timeoutMs ?? 0)}ms`),
        );
      }, Math.trunc(params.timeoutMs));
      timeout.unref?.();
    }

    const socket = await agent.connect(req, {
      host: params.targetHost,
      port: params.targetPort,
      secureEndpoint: true,
      servername: params.targetHost,
      ALPNProtocols: ["h2"],
    });

    if (!isSuccessfulProxySocket(socket)) {
      throw new Error("proxy returned an unusable CONNECT socket");
    }

    clear();
    return socket;
  } catch (err) {
    clear();
    throw new Error(
      `Proxy CONNECT failed via ${redactProxyUrl(params.proxyUrl)}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
