import * as net from "node:net";
import * as tls from "node:tls";

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

function resolveProxyHost(proxy: URL): string {
  return (proxy.hostname || proxy.host).replace(/^\[|\]$/g, "");
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

function formatTunnelFailure(proxyUrl: string, err: unknown): Error {
  return new Error(
    `Proxy CONNECT failed via ${redactProxyUrl(proxyUrl)}: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}

function writeConnectRequest(socket: net.Socket, proxy: URL, target: string): void {
  const headers = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`, "Proxy-Connection: Keep-Alive"];
  const authorization = resolveProxyAuthorization(proxy);
  if (authorization) {
    headers.push(`Proxy-Authorization: ${authorization}`);
  }
  socket.write([...headers, "", ""].join("\r\n"));
}

export async function openHttpConnectTunnel(params: HttpConnectTunnelParams): Promise<net.Socket> {
  const proxy = new URL(params.proxyUrl);
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
    throw new Error(`Unsupported proxy protocol for APNs HTTP/2 CONNECT tunnel: ${proxy.protocol}`);
  }

  return await new Promise<net.Socket>((resolve, reject) => {
    let proxySocket: net.Socket | tls.TLSSocket | undefined;
    let targetTlsSocket: tls.TLSSocket | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let settled = false;
    let responseBuffer = Buffer.alloc(0);

    const clearTimer = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    };

    const cleanupProxyListeners = () => {
      proxySocket?.off("data", onData);
      proxySocket?.off("end", onEnd);
      proxySocket?.off("error", onError);
      proxySocket?.off("close", onClose);
      proxySocket?.off("connect", onConnected);
      proxySocket?.off("secureConnect", onConnected);
    };

    const fail = (err: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      cleanupProxyListeners();
      targetTlsSocket?.destroy();
      proxySocket?.destroy();
      reject(formatTunnelFailure(params.proxyUrl, err));
    };

    const succeed = (socket: tls.TLSSocket) => {
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      clearTimer();
      cleanupProxyListeners();
      resolve(socket);
    };

    function onConnected(): void {
      if (!proxySocket) {
        fail(new Error("Proxy socket missing after connect"));
        return;
      }
      const target = `${params.targetHost}:${params.targetPort}`;
      writeConnectRequest(proxySocket, proxy, target);
    }

    function onData(chunk: Buffer | string): void {
      const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "latin1");
      responseBuffer = Buffer.concat([responseBuffer, nextChunk]);
      const headerEnd = responseBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1 || !proxySocket) {
        return;
      }

      const bodyOffset = headerEnd + 4;
      if (responseBuffer.length > bodyOffset) {
        proxySocket.unshift(responseBuffer.subarray(bodyOffset));
      }
      const responseHeader = responseBuffer.subarray(0, bodyOffset).toString("latin1");
      const statusLine = responseHeader.split("\r\n", 1)[0] ?? "";
      if (!/^HTTP\/1\.[01] 2\d\d\b/.test(statusLine)) {
        fail(new Error(statusLine || "Proxy returned an invalid CONNECT response"));
        return;
      }

      cleanupProxyListeners();
      targetTlsSocket = tls.connect({
        socket: proxySocket,
        servername: params.targetHost,
        ALPNProtocols: ["h2"],
      });
      succeed(targetTlsSocket);
    }

    function onEnd(): void {
      fail(new Error("Proxy closed before CONNECT response"));
    }

    function onClose(): void {
      fail(new Error("Proxy closed before CONNECT response"));
    }

    function onError(err: Error): void {
      fail(err);
    }

    try {
      if (params.timeoutMs && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0) {
        timeout = setTimeout(() => {
          fail(new Error(`Proxy CONNECT timed out after ${Math.trunc(params.timeoutMs ?? 0)}ms`));
        }, Math.trunc(params.timeoutMs));
      }

      const proxyHost = resolveProxyHost(proxy);
      const connectOptions = {
        host: proxyHost,
        port: resolveProxyPort(proxy),
      };
      proxySocket =
        proxy.protocol === "https:"
          ? tls.connect({
              ...connectOptions,
              servername: proxyHost,
              ALPNProtocols: ["http/1.1"],
            })
          : net.connect(connectOptions);

      proxySocket.once(proxy.protocol === "https:" ? "secureConnect" : "connect", onConnected);
      proxySocket.on("data", onData);
      proxySocket.once("end", onEnd);
      proxySocket.once("error", onError);
      proxySocket.once("close", onClose);
    } catch (err) {
      fail(err);
    }
  });
}
