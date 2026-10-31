import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import * as net from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "../../../../packages/gateway-client/src/websocket.test-support.js";
import { withTestDir } from "../../../test-helpers/temp-dir.js";
import { createNodeEvalArgs } from "../../../test-utils/node-process.js";
import { resolveSystemBin } from "../../resolve-system-bin.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../../runtime-worker-url.js";
import { resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir.js";
import { externalProxyTestEntrypoints } from "./external-proxy-runtime.test-support.js";

const CHILD_PROCESS_TIMEOUT_MS = process.env.CI ? 45_000 : 15_000;
const PROBE_TIMEOUT_MS = process.env.CI ? 15_000 : 5_000;
const lifecycleUrl = resolveRuntimeWorkerUrl(externalProxyTestEntrypoints.lifecycle);
const websocketUrl = resolveRuntimeWorkerUrl(externalProxyTestEntrypoints.websocket);
const tunnelSockets = new Set<Duplex>();

function respond(status: number, body: string): RequestListener {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(body);
  };
}

function createDiscordTlsFixture(dir: string) {
  const openssl = resolveSystemBin("openssl");
  if (!openssl) {
    throw new Error("openssl is required to generate proxy TLS test certificates");
  }
  execFileSync(
    openssl,
    "req -x509 -newkey rsa:2048 -nodes -keyout server-key.pem -out server-cert.pem -days 1 -subj /CN=discord.com -addext subjectAltName=DNS:discord.com".split(
      " ",
    ),
    { cwd: dir, stdio: "ignore" },
  );
  return {
    caPath: join(dir, "server-cert.pem"),
    cert: readFileSync(join(dir, "server-cert.pem"), "utf8"),
    key: readFileSync(join(dir, "server-key.pem"), "utf8"),
  };
}

const servers: Server[] = [];
async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  servers.push(server);
  const listening = once(server, "listening");
  server.listen(0, host);
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind to a TCP port");
  }
  return address.port;
}

function createTunnelProxy(seenConnectTargets: string[], tlsTargetPort?: number): Server {
  function trackSocket(socket: Duplex) {
    tunnelSockets.add(socket);
    socket.once("close", () => tunnelSockets.delete(socket));
  }
  const proxy = createServer((req, res) => {
    // Both scenarios require HTTP to stay direct; only CONNECT may use this proxy.
    seenConnectTargets.push(req.url ?? "");
    res.writeHead(502);
    res.end("unexpected HTTP proxy request");
  });

  proxy.on("connect", (req, clientSocket, head) => {
    const target = req.url ?? "";
    seenConnectTargets.push(target);

    if (tlsTargetPort === undefined || target !== `discord.com:${tlsTargetPort}`) {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    trackSocket(clientSocket);
    const upstream = net.connect(tlsTargetPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    trackSocket(upstream);

    upstream.on("error", () => {
      if (!clientSocket.destroyed && !clientSocket.writableEnded) {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
    });
  });

  proxy.on("upgrade", (req, socket) => {
    seenConnectTargets.push(req.url ?? "");
    socket.destroy();
  });

  return proxy;
}

async function runNodeModule(source: string, env: NodeJS.ProcessEnv, imports = "") {
  const script = `
        ${imports}
        import assert from "node:assert/strict";
        import { once } from "node:events";
        import http from "node:http";
        import https from "node:https";
        import { text } from "node:stream/consumers";
        import { startProxy, stopProxy } from ${JSON.stringify(lifecycleUrl.href)};

        async function nodeGet(url, options = {}) {
          const response = await new Promise((resolve, reject) => {
            const client = url.startsWith("https:") ? https : http;
            const req = client.get(url, options, resolve);
            req.setTimeout(${PROBE_TIMEOUT_MS}, () => req.destroy(new Error("node request timed out")));
            req.on("error", reject);
          });
          return { status: response.statusCode, body: await text(response) };
        }

        const handle = await startProxy({ enabled: true });
        assert.notEqual(handle, null, "expected external proxy routing to start");
        try {
          ${source}
        } finally {
          await stopProxy(handle);
        }
  `;
  return await promisify(execFile)(
    process.execPath,
    [...resolveRuntimeWorkerArgv(lifecycleUrl).slice(0, -1), ...createNodeEvalArgs(script)],
    {
      cwd: process.cwd(),
      env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "localhost", ...env },
      timeout: CHILD_PROCESS_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
}

describe("SSRF external proxy routing", () => {
  const webSockets: WebSocketServer[] = [];
  function wsTarget(): Server {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    webSockets.push(wss);
    wss.on("connection", (ws) => ws.close(1000, "done"));
    return server;
  }

  afterEach(async () => {
    for (const socket of tunnelSockets) {
      socket.destroy();
    }
    tunnelSockets.clear();
    for (const wss of webSockets.splice(0)) {
      await promisify(wss.close.bind(wss))();
    }
    for (const server of servers.splice(0).toReversed()) {
      if (server.listening) {
        server.closeAllConnections();
        await promisify(server.close.bind(server))();
      }
    }
  });

  it("keeps runtime loopback HTTP and WebSocket requests direct with managed proxy enabled", async () => {
    const targetPort = await listen(createServer(respond(218, "from loopback target")));
    const globalFetchTargetPort = await listen(
      createServer(respond(219, "from global fetch target")),
      "::1",
    );
    const wsTargetPort = await listen(wsTarget());
    const seenConnectTargets: string[] = [];
    const proxyPort = await listen(createTunnelProxy(seenConnectTargets));
    const child = await runNodeModule(
      `
        async function websocketProbe(url, bypass = false) {
          const unregister = bypass ? registerManagedProxyGatewayLoopbackBypass(url) : undefined;
          const ws = new WebSocket(url, { handshakeTimeout: ${PROBE_TIMEOUT_MS} });
          try {
            await once(ws, "open");
          } finally {
            unregister?.();
            ws.close();
          }
        }
          async function fetchGet(fetcher, url) {
            const response = await fetcher(url, { signal: AbortSignal.timeout(${PROBE_TIMEOUT_MS}) });
            return { status: response.status, body: await response.text() };
          }
          console.log(JSON.stringify({
            fetch: await fetchGet(undiciFetch, "http://127.0.0.1:${targetPort}/private-metadata"),
            globalFetch: await fetchGet(fetch, "http://[::1]:${globalFetchTargetPort}/global-fetch-metadata"),
            nodeHttp: await nodeGet("http://localhost:${targetPort}/node-http-metadata"),
            explicitAgent: await nodeGet("http://127.0.0.1:${targetPort}/explicit-agent", { agent: new http.Agent() }),
          }));
          await assert.rejects(() =>
            nodeGet("https://127.0.0.1:${targetPort}/https-connect-proof", { rejectUnauthorized: false }),
          );
          await websocketProbe("ws://127.0.0.1:${wsTargetPort}/websocket-proxied");
          await websocketProbe("ws://127.0.0.1:${wsTargetPort}/gateway-bypass", true);
          await assert.rejects(() =>
            websocketProbe("wss://gateway.example.com/socket", true),
          );
      `,
      { OPENCLAW_PROXY_URL: `http://127.0.0.1:${proxyPort}` },
      `import { fetch as undiciFetch } from "undici";
        import { WebSocket } from ${JSON.stringify(websocketUrl.href)};
        import { registerManagedProxyGatewayLoopbackBypass } from ${JSON.stringify(lifecycleUrl.href)};`,
    );

    expect(child.stderr).toBe("");
    expect(child.stdout).toContain('"fetch":{"status":218');
    expect(child.stdout).toContain('"globalFetch":{"status":219');
    expect(child.stdout).toContain('"nodeHttp":{"status":218');
    expect(child.stdout).toContain('"explicitAgent":{"status":218');
    expect(child.stdout).toContain('"body":"from loopback target"');
    expect(seenConnectTargets).toEqual(["gateway.example.com:443"]);
  });

  it("preserves the target TLS hostname for Node HTTPS requests through the managed proxy", async () => {
    await withTestDir(
      { prefix: "openclaw-discord-tls-", parentDir: resolvePreferredOpenClawTmpDir() },
      async (dir) => {
        const tlsFixture = createDiscordTlsFixture(dir);
        const tlsTargetPort = await listen(
          createHttpsServer(tlsFixture, respond(209, "discord target tls ok")),
        );
        const seenConnectTargets: string[] = [];
        const proxyPort = await listen(createTunnelProxy(seenConnectTargets, tlsTargetPort));
        const child = await runNodeModule(
          `
          const response = await nodeGet("https://discord.com:${tlsTargetPort}/tls-proxy-proof");
          console.log(JSON.stringify(response));
      `,
          {
            NODE_EXTRA_CA_CERTS: tlsFixture.caPath,
            OPENCLAW_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
          },
        );

        expect(child.stderr).toBe("");
        expect(child.stdout).toContain('"status":209');
        expect(child.stdout).toContain('"body":"discord target tls ok"');
        expect(seenConnectTargets).toContain(`discord.com:${tlsTargetPort}`);
      },
    );
  });
});
