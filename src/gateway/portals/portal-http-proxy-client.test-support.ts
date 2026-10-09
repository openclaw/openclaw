import { once } from "node:events";
import { request, type IncomingMessage } from "node:http";
import net from "node:net";
import { type RawData, WebSocket } from "ws";

type HttpResult = {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
};

export async function httpCall(params: {
  port: number;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return await new Promise<HttpResult>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: params.port,
        path: params.path ?? "/",
        method: params.method,
        headers: params.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.once("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.once("error", reject);
    if (params.body) {
      req.write(params.body);
    }
    req.end();
  });
}

export async function readUpgradeRejection(params: {
  port: number;
  host?: string;
}): Promise<{ status: number; body: string; elapsedMs: number }> {
  const started = Date.now();
  const socket = net.connect({ host: "127.0.0.1", port: params.port });
  await once(socket, "connect");
  socket.write(
    [
      "GET / HTTP/1.1",
      `Host: ${params.host ?? `127.0.0.1:${params.port}`}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "",
      "",
    ].join("\r\n"),
  );
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  await Promise.race([once(socket, "close"), once(socket, "end")]);
  socket.destroy();
  const raw = Buffer.concat(chunks).toString("utf8");
  const separator = raw.indexOf("\r\n\r\n");
  const head = separator >= 0 ? raw.slice(0, separator) : raw;
  const body = (separator >= 0 ? raw.slice(separator + 4) : "").replace(/\r\n$/u, "");
  return {
    status: Number(head.split(" ")[1]),
    body,
    elapsedMs: Date.now() - started,
  };
}

export function storeCookies(
  jar: Map<string, string>,
  cookies: readonly string[] | undefined,
): void {
  for (const cookie of cookies ?? []) {
    const pair = cookie.split(";", 1)[0];
    const separator = pair?.indexOf("=") ?? -1;
    if (pair && separator > 0) {
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
}

function storeResponseCookies(jar: Map<string, string>, result: HttpResult): void {
  storeCookies(jar, result.headers["set-cookie"]);
}

export function cookieJarHeader(jar: ReadonlyMap<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function portalAuthCookie(portal: { listenPort: number; tokenQuery: string }): string {
  const token = portal.tokenQuery.slice("openclaw_portal=".length);
  return `openclaw_portal_${portal.listenPort}=${token}`;
}

export function webSocketMessageText(data: RawData): string {
  const bytes = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : data;
  return bytes.toString("utf8");
}

export async function openWebSocket(
  url: string,
  headers?: Record<string, string>,
): Promise<{ socket: WebSocket; setCookies: string[] | undefined }> {
  let setCookies: string[] | undefined;
  const socket = new WebSocket(url, headers ? { headers } : undefined);
  socket.once("upgrade", (response) => {
    setCookies = response.headers["set-cookie"];
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, setCookies };
}

export async function closeWebSocket(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    socket.once("close", resolve);
    socket.close();
  });
}

export async function browserCall(
  jar: Map<string, string>,
  params: Omit<Parameters<typeof httpCall>[0], "headers">,
): Promise<HttpResult> {
  const cookie = cookieJarHeader(jar);
  const result = await httpCall({
    ...params,
    ...(cookie ? { headers: { Cookie: cookie } } : {}),
  });
  storeResponseCookies(jar, result);
  return result;
}
