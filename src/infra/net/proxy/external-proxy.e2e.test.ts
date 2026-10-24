import { execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
  // Only fixed fixture filenames are split; the directory and subject stay separate arguments.
  const runOpenSsl = (args: string, subject?: string) =>
    execFileSync(openssl, [...args.split(" "), ...(subject ? ["-subj", subject] : [])], {
      cwd: dir,
      stdio: "ignore",
    });
  runOpenSsl(
    "req -x509 -newkey rsa:2048 -nodes -keyout ca-key.pem -out ca-cert.pem -days 1",
    "/CN=OpenClaw Proxy Test CA",
  );
  runOpenSsl(
    "req -newkey rsa:2048 -nodes -keyout server-key.pem -out server.csr",
    "/CN=discord.com",
  );
  writeFileSync(join(dir, "server-ext.cnf"), "subjectAltName=DNS:discord.com\n");
  runOpenSsl(
    "x509 -req -in server.csr -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial -out server-cert.pem -days 1 -sha256 -extfile server-ext.cnf",
  );

  return {
    caPath: join(dir, "ca-cert.pem"),
    cert: readFileSync(join(dir, "server-cert.pem"), "utf8"),
    key: readFileSync(join(dir, "server-key.pem"), "utf8"),
  };
}

async function listenOnLoopback(server: Server, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function createTunnelProxy(
  seenConnectTargets: string[],
  connectTargetOverrides: Record<string, { hostname: string; port: number }> = {},
): Server {
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

    const targetUrl = new URL(`http://${target}`);
    const override = connectTargetOverrides[target];
    trackSocket(clientSocket);
    const upstream = net.connect(
      override?.port ?? Number(targetUrl.port),
      override?.hostname ?? targetUrl.hostname,
      () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
          upstream.write(head);
        }
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      },
    );
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
        import http from "node:http";
        import https from "node:https";
        import { startProxy, stopProxy } from ${JSON.stringify(lifecycleUrl.href)};

        async function nodeGet(url, options = {}) {
          return new Promise((resolve, reject) => {
            const client = url.startsWith("https:") ? https : http;
            const req = client.get(url, options, (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk) => { body += chunk; });
              response.on("end", () => resolve({ status: response.statusCode, body }));
            });
            req.setTimeout(${PROBE_TIMEOUT_MS}, () => {
              req.destroy(new Error("node request timed out"));
            });
            req.on("error", reject);
          });
        }

        const handle = await startProxy({ enabled: true });
        if (handle === null) {
          throw new Error("expected external proxy routing to start");
        }
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
  const servers: Server[] = [];
  const webSockets: WebSocketServer[] = [];
  async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
    servers.push(server);
    return listenOnLoopback(server, host);
  }
  function httpTarget(status: number, body: string): Server {
    return createServer(respond(status, body));
  }
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
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    }
    for (const server of servers.splice(0).toReversed()) {
      if (server.listening) {
        server.closeAllConnections();
        await promisify(server.close.bind(server))();
      }
    }
  });

  it("keeps runtime loopback HTTP and WebSocket requests direct with managed proxy enabled", async () => {
    const targetPort = await listen(httpTarget(218, "from loopback target"));
    const globalFetchTargetPort = await listen(httpTarget(219, "from global fetch target"), "::1");
    const wsTargetPort = await listen(wsTarget());
    const seenConnectTargets: string[] = [];
    const proxyPort = await listen(createTunnelProxy(seenConnectTargets));
    const child = await runNodeModule(
      `
        async function expectFailure(label, run) {
          try {
            await run();
          } catch {
            return;
          }
          throw new Error(label + " unexpectedly succeeded");
        }

        async function websocketProbe(url, bypass = false) {
          return new Promise((resolve, reject) => {
            const unregister = bypass ? registerManagedProxyGatewayLoopbackBypass(url) : undefined;
            const ws = new WebSocket(url, { handshakeTimeout: ${PROBE_TIMEOUT_MS} });
            ws.once("open", () => {
              ws.close();
              unregister?.();
              resolve();
            });
            ws.once("error", (err) => {
              unregister?.();
              reject(err);
            });
          });
        }
          const response = await undiciFetch(process.env.OPENCLAW_TEST_TARGET_URL, {
            signal: AbortSignal.timeout(${PROBE_TIMEOUT_MS}),
          });
          const body = await response.text();
          const globalFetchResponse = await fetch(process.env.OPENCLAW_TEST_GLOBAL_FETCH_TARGET_URL, {
            signal: AbortSignal.timeout(${PROBE_TIMEOUT_MS}),
          });
          const globalFetchBody = await globalFetchResponse.text();
          const nodeHttp = await nodeGet(process.env.OPENCLAW_TEST_NODE_HTTP_TARGET_URL);
          const explicitAgent = await nodeGet(process.env.OPENCLAW_TEST_EXPLICIT_AGENT_TARGET_URL, {
            agent: new http.Agent(),
          });
          await expectFailure("node:https", () =>
            nodeGet(process.env.OPENCLAW_TEST_NODE_HTTPS_TARGET_URL, { rejectUnauthorized: false }),
          );
          await websocketProbe(process.env.OPENCLAW_TEST_WS_TARGET_URL);
          await websocketProbe(process.env.OPENCLAW_TEST_GATEWAY_BYPASS_WS_URL, true);
          await expectFailure("non-loopback bypass", () =>
            websocketProbe("wss://gateway.example.com/socket", true),
          );
          console.log(JSON.stringify({
            fetch: { status: response.status, body },
            globalFetch: { status: globalFetchResponse.status, body: globalFetchBody },
            nodeHttp,
            explicitAgent,
          }));
      `,
      {
        OPENCLAW_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
        OPENCLAW_TEST_TARGET_URL: `http://127.0.0.1:${targetPort}/private-metadata`,
        OPENCLAW_TEST_GLOBAL_FETCH_TARGET_URL: `http://[::1]:${globalFetchTargetPort}/global-fetch-metadata`,
        OPENCLAW_TEST_NODE_HTTP_TARGET_URL: `http://localhost:${targetPort}/node-http-metadata`,
        OPENCLAW_TEST_EXPLICIT_AGENT_TARGET_URL: `http://127.0.0.1:${targetPort}/explicit-agent`,
        OPENCLAW_TEST_NODE_HTTPS_TARGET_URL: `https://127.0.0.1:${targetPort}/https-connect-proof`,
        OPENCLAW_TEST_WS_TARGET_URL: `ws://127.0.0.1:${wsTargetPort}/websocket-proxied`,
        OPENCLAW_TEST_GATEWAY_BYPASS_WS_URL: `ws://127.0.0.1:${wsTargetPort}/gateway-bypass`,
      },
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
        const proxyPort = await listen(
          createTunnelProxy(seenConnectTargets, {
            [`discord.com:${tlsTargetPort}`]: { hostname: "127.0.0.1", port: tlsTargetPort },
          }),
        );
        const child = await runNodeModule(
          `
          const response = await nodeGet(process.env.OPENCLAW_TEST_DISCORD_TLS_URL);
          console.log(JSON.stringify(response));
      `,
          {
            NODE_EXTRA_CA_CERTS: tlsFixture.caPath,
            OPENCLAW_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
            OPENCLAW_TEST_DISCORD_TLS_URL: `https://discord.com:${tlsTargetPort}/tls-proxy-proof`,
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
