import { once } from "node:events";
import * as net from "node:net";

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

function resolveProxyPort(proxy: URL): number {
  if (proxy.port) {
    return Number(proxy.port);
  }
  return proxy.protocol === "https:" ? 443 : 80;
}

function resolveProxyAuthorization(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) {
    return undefined;
  }
  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function readConnectResponse(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onData = (chunk: Buffer | string) => {
      const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "latin1");
      buffer = Buffer.concat([buffer, nextChunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      cleanup();
      const bodyOffset = headerEnd + 4;
      if (buffer.length > bodyOffset) {
        socket.unshift(buffer.subarray(bodyOffset));
      }
      resolve(buffer.subarray(0, bodyOffset).toString("latin1"));
    };
    const onEnd = () => fail(new Error("Proxy closed before CONNECT response"));
    const onError = (err: Error) => fail(err);
    const onClose = () => fail(new Error("Proxy closed before CONNECT response"));

    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

export async function openHttpConnectTunnel(params: HttpConnectTunnelParams): Promise<net.Socket> {
  const proxy = new URL(params.proxyUrl);
  if (proxy.protocol !== "http:") {
    throw new Error(`Unsupported proxy protocol for APNs HTTP/2 CONNECT tunnel: ${proxy.protocol}`);
  }
  const socket = net.connect({ host: proxy.hostname, port: resolveProxyPort(proxy) });
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
        socket.destroy(
          new Error(`Proxy CONNECT timed out after ${Math.trunc(params.timeoutMs ?? 0)}ms`),
        );
      }, Math.trunc(params.timeoutMs));
      timeout.unref?.();
    }

    await once(socket, "connect");
    const target = `${params.targetHost}:${params.targetPort}`;
    const headers = [
      `CONNECT ${target} HTTP/1.1`,
      `Host: ${target}`,
      "Proxy-Connection: Keep-Alive",
    ];
    const authorization = resolveProxyAuthorization(proxy);
    if (authorization) {
      headers.push(`Proxy-Authorization: ${authorization}`);
    }
    socket.write([...headers, "", ""].join("\r\n"));

    const response = await readConnectResponse(socket);
    const statusLine = response.split("\r\n", 1)[0] ?? "";
    if (!/^HTTP\/1\.[01] 2\d\d\b/.test(statusLine)) {
      socket.destroy();
      throw new Error(`Proxy CONNECT failed via ${redactProxyUrl(params.proxyUrl)}: ${statusLine}`);
    }
    clear();
    return socket;
  } catch (err) {
    clear();
    if (!socket.destroyed) {
      socket.destroy();
    }
    throw err;
  }
}
