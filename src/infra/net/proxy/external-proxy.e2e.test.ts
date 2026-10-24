import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
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
const PROXY_TUNNEL_SOCKETS = new WeakMap<Server, Set<Duplex>>();
type DiscordTlsFixture = {
  caPath: string;
  cert: string;
  key: string;
};

function createDiscordTlsFixture(dir: string): DiscordTlsFixture {
  const openssl = resolveSystemBin("openssl");
  if (!openssl) {
    throw new Error("openssl is required to generate proxy TLS test certificates");
  }
  const caCertPath = join(dir, "ca-cert.pem");
  const serverKeyPath = join(dir, "server-key.pem");
  const serverCertPath = join(dir, "server-cert.pem");
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
    caPath: caCertPath,
    cert: readFileSync(serverCertPath, "utf8"),
    key: readFileSync(serverKeyPath, "utf8"),
  };
}

async function withDiscordTlsFixture<T>(
  run: (fixture: DiscordTlsFixture) => Promise<T>,
): Promise<T> {
  return await withTestDir(
    {
      prefix: "openclaw-discord-tls-",
      parentDir: resolvePreferredOpenClawTmpDir(),
    },
    async (dir) => run(createDiscordTlsFixture(dir)),
  );
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

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  for (const socket of PROXY_TUNNEL_SOCKETS.get(server) ?? []) {
    socket.destroy();
  }
  server.closeAllConnections?.();
  await promisify(server.close.bind(server))();
}

type ConnectTargetOverride = {
  hostname: string;
  port: number;
};

function createTunnelProxy(
  seenConnectTargets: string[],
  connectTargetOverrides: Record<string, ConnectTargetOverride> = {},
): Server {
  const tunnelSockets = new Set<Duplex>();
  function trackSocket(socket: Duplex) {
    tunnelSockets.add(socket);
    socket.once("close", () => tunnelSockets.delete(socket));
  }
  const proxy = createServer((req, res) => {
    const target = req.url ?? "";
    seenConnectTargets.push(target);

    let targetUrl: URL;
    try {
      targetUrl = new URL(target);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("absolute-form proxy URL required");
      return;
    }

    const upstream = httpRequest(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: req.method,
        headers: { ...req.headers, host: targetUrl.host, connection: "close" },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    upstream.on("error", () => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("upstream error");
    });
    req.pipe(upstream);
  });
  PROXY_TUNNEL_SOCKETS.set(proxy, tunnelSockets);

  proxy.on("connect", (req, clientSocket, head) => {
    const target = req.url ?? "";
    seenConnectTargets.push(target);

    let targetUrl: URL;
    try {
      targetUrl = new URL(`http://${target}`);
    } catch {
      clientSocket.destroy();
      return;
    }

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

async function runNodeModule(
  source: string,
  env: NodeJS.ProcessEnv,
  imports = "",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
  const child = spawn(
    process.execPath,
    [...resolveRuntimeWorkerArgv(lifecycleUrl).slice(0, -1), ...createNodeEvalArgs(script)],
    {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child process timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, CHILD_PROCESS_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("SSRF external proxy routing", () => {
  const servers: Server[] = [];
  const webSockets: WebSocketServer[] = [];
  function track(server: Server): Server {
    servers.push(server);
    return server;
  }
  function httpTarget(status: number, body: string): Server {
    return track(
      createServer((_req, res) => {
        res.writeHead(status, { "content-type": "text/plain" });
        res.end(body);
      }),
    );
  }
  function wsTarget(): Server {
    const server = track(createServer());
    const wss = new WebSocketServer({ server });
    webSockets.push(wss);
    wss.on("connection", (ws) => ws.close(1000, "done"));
    return server;
  }

  afterEach(async () => {
    for (const wss of webSockets.splice(0)) {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    }
    for (const server of servers.splice(0).toReversed()) {
      await closeServer(server);
    }
  });

  it("keeps runtime loopback HTTP and WebSocket requests direct with managed proxy enabled", async () => {
    const target = httpTarget(218, "from loopback target");
    const globalFetchTarget = httpTarget(219, "from global fetch target");
    const targetPort = await listenOnLoopback(target);
    const globalFetchTargetPort = await listenOnLoopback(globalFetchTarget, "::1");
    const wsTargetPort = await listenOnLoopback(wsTarget());
    const gatewayBypassWsTargetPort = await listenOnLoopback(wsTarget());
    const httpsLikeTarget = httpTarget(200, "plain target for https CONNECT proof");
    const httpsLikeTargetPort = await listenOnLoopback(httpsLikeTarget);
    const seenConnectTargets: string[] = [];
    const proxy = track(createTunnelProxy(seenConnectTargets));
    const proxyPort = await listenOnLoopback(proxy);
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
        ...process.env,
        OPENCLAW_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
        OPENCLAW_TEST_TARGET_URL: `http://127.0.0.1:${targetPort}/private-metadata`,
        OPENCLAW_TEST_GLOBAL_FETCH_TARGET_URL: `http://[::1]:${globalFetchTargetPort}/global-fetch-metadata`,
        OPENCLAW_TEST_NODE_HTTP_TARGET_URL: `http://localhost:${targetPort}/node-http-metadata`,
        OPENCLAW_TEST_EXPLICIT_AGENT_TARGET_URL: `http://127.0.0.1:${targetPort}/explicit-agent`,
        OPENCLAW_TEST_NODE_HTTPS_TARGET_URL: `https://127.0.0.1:${httpsLikeTargetPort}/https-connect-proof`,
        OPENCLAW_TEST_WS_TARGET_URL: `ws://127.0.0.1:${wsTargetPort}/websocket-proxied`,
        OPENCLAW_TEST_GATEWAY_BYPASS_WS_URL: `ws://127.0.0.1:${gatewayBypassWsTargetPort}/gateway-bypass`,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "localhost",
      },
      `import { fetch as undiciFetch } from "undici";
        import { WebSocket } from ${JSON.stringify(websocketUrl.href)};
        import { registerManagedProxyGatewayLoopbackBypass } from ${JSON.stringify(lifecycleUrl.href)};`,
    );

    expect(child.stderr).toBe("");
    expect(child.code).toBe(0);
    expect(child.stdout).toContain('"fetch":{"status":218');
    expect(child.stdout).toContain('"globalFetch":{"status":219');
    expect(child.stdout).toContain('"nodeHttp":{"status":218');
    expect(child.stdout).toContain('"explicitAgent":{"status":218');
    expect(child.stdout).toContain('"body":"from loopback target"');
    expect(seenConnectTargets).toEqual(["gateway.example.com:443"]);
  });

  it("preserves the target TLS hostname for Node HTTPS requests through the managed proxy", async () => {
    await withDiscordTlsFixture(async (tlsFixture) => {
      const tlsTarget = track(
        createHttpsServer({ key: tlsFixture.key, cert: tlsFixture.cert }, (_req, res) => {
          res.writeHead(209, { "content-type": "text/plain" });
          res.end("discord target tls ok");
        }),
      );
      const tlsTargetPort = await listenOnLoopback(tlsTarget);
      const seenConnectTargets: string[] = [];
      const proxy = track(
        createTunnelProxy(seenConnectTargets, {
          [`discord.com:${tlsTargetPort}`]: { hostname: "127.0.0.1", port: tlsTargetPort },
        }),
      );
      const proxyPort = await listenOnLoopback(proxy);
      const child = await runNodeModule(
        `
          const response = await nodeGet(process.env.OPENCLAW_TEST_DISCORD_TLS_URL);
          console.log(JSON.stringify(response));
      `,
        {
          ...process.env,
          NODE_EXTRA_CA_CERTS: tlsFixture.caPath,
          OPENCLAW_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
          OPENCLAW_TEST_DISCORD_TLS_URL: `https://discord.com:${tlsTargetPort}/tls-proxy-proof`,
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "localhost",
        },
      );

      expect(child.stderr).toBe("");
      expect(child.code).toBe(0);
      expect(child.stdout).toContain('"status":209');
      expect(child.stdout).toContain('"body":"discord target tls ok"');
      expect(seenConnectTargets).toContain(`discord.com:${tlsTargetPort}`);
    });
  });
});
