import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { unlink, writeFile } from "node:fs/promises";
import * as http from "node:http";
import { createServer } from "node:https";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { waitForGatewayHttpReadiness } from "../cli/daemon-cli/restart-health-probe.js";
import { startProxy } from "../infra/net/proxy/proxy-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { PROXY_FIXTURE_CERTIFICATE, PROXY_FIXTURE_KEY } from "../test-helpers/proxy-tls-fixture.js";
import { createSuiteTempRootTracker, withTestDir } from "../test-helpers/temp-dir.js";
import {
  createConfiguredGatewayLocalProbe,
  type ConfiguredGatewayLocalProbe,
} from "./local-http-probe.js";

const tls = { cert: TEST_TLS_CERT_PEM, key: TEST_TLS_KEY_PEM };
const pin = (cert: string) =>
  new X509Certificate(cert).fingerprint256.replaceAll(":", "").toLowerCase();
const liveBody = '{"ok":true,"status":"live"}';
const respondLive: http.RequestListener = (_request, response) => response.end(liveBody);
async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP listener");
  }
  return address.port;
}
async function close(server: http.Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
function requestHttp(
  probe: ConfiguredGatewayLocalProbe,
  port: number,
  options: Partial<Parameters<ConfiguredGatewayLocalProbe["requestHttp"]>[0]> = {},
) {
  const defaults = { host: "127.0.0.1", pathname: "/healthz", timeoutMs: 1000 } as const;
  return probe.requestHttp({ ...defaults, port, ...options });
}
const configFor = (certPath: string) => ({
  gateway: {
    tls: {
      enabled: true,
      autoGenerate: false,
      certPath,
      keyPath: path.join(path.dirname(certPath), "missing-key.pem"),
    },
  },
});

test("reads detailed channel outages and retains status when the body exceeds its bound", async () => {
  let oversized = false;
  const failing = Array.from({ length: 80 }, (_, index) => `channel-${index}-${"x".repeat(30)}`);
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === "/readyz" ? 503 : 200).end(
      JSON.stringify({
        ready: false,
        coreReady: true,
        failing,
        ...(oversized ? { padding: "x".repeat(70_000) } : {}),
      }),
    );
  });
  const port = await listen(server);
  const observe = () =>
    waitForGatewayHttpReadiness({
      attempts: 1,
      deadlineAt: performance.now() + 1000,
      delayMs: 0,
      port,
      requireChannelHealth: false,
    });
  try {
    expect(await observe()).toEqual({
      healthz: 200,
      readyz: 503,
      coreReady: true,
      failingChannels: failing,
    });
    oversized = true;
    expect(await observe()).toEqual({ healthz: 200, readyz: 503, coreReady: false });
  } finally {
    await close(server);
  }
});

describe("local TLS probes", () => {
  const dirs = createSuiteTempRootTracker({ prefix: "openclaw-local-http-probe-" });
  const servers: http.Server[] = [];
  let directory: string, certPath: string, port: number;
  let server: ReturnType<typeof createServer>,
    probe: ConfiguredGatewayLocalProbe,
    handler: http.RequestListener;
  beforeEach(async () => {
    directory = await dirs.setup();
    certPath = path.join(directory, "cert.pem");
    await writeFile(certPath, TEST_TLS_CERT_PEM);
    handler = respondLive;
    server = createServer(tls, (request, response) => handler(request, response));
    servers.push(server);
    port = await listen(server);
    probe = createConfiguredGatewayLocalProbe(configFor(certPath));
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
    await dirs.cleanup();
  });
  test("probes directly under a managed proxy while enforcing its certificate pin", async () => {
    const paths: string[] = [];
    handler = (request, response) => {
      paths.push(request.url ?? "");
      response.end(JSON.stringify({ ready: request.url === "/readyz" }));
    };
    // The configured private key is absent: client probes need only the public certificate.
    const config = configFor(certPath);
    const proxy = await startProxy({ proxyUrl: "http://127.0.0.1:1" });
    try {
      await expect(
        waitForGatewayHttpReadiness({
          attempts: 1,
          config,
          deadlineAt: performance.now() + 1_000,
          delayMs: 0,
          port,
        }),
      ).resolves.toEqual({ healthz: 200, readyz: 200 });
      expect(paths).toEqual(expect.arrayContaining(["/healthz", "/readyz"]));
      for (const host of ["0.0.0.0", "::", "127.0.0.1"]) {
        await expect(
          requestHttp(probe, port, { host, pathname: "/readyz" }),
        ).resolves.toMatchObject({ statusCode: 200, body: JSON.stringify({ ready: true }) });
      }
      const mismatchedCertPath = path.join(directory, "mismatched-cert.pem");
      await writeFile(mismatchedCertPath, PROXY_FIXTURE_CERTIFICATE);
      const mismatchedProbe = createConfiguredGatewayLocalProbe(configFor(mismatchedCertPath));
      await expect(requestHttp(mismatchedProbe, port, { pathname: "/readyz" })).resolves.toBeNull();
    } finally {
      await proxy?.stop();
    }
  });

  test("keeps a WebSocket-first verified pin scoped to its endpoint", async () => {
    const secondServer = createServer(tls, respondLive);
    servers.push(secondServer);
    const secondPort = await listen(secondServer);
    const first = await probe.resolveWebSocketTarget(port);
    expect(first).toEqual({
      url: `wss://127.0.0.1:${port}`,
      tlsFingerprint: pin(TEST_TLS_CERT_PEM),
    });
    await unlink(certPath);
    expect(await probe.resolveWebSocketTarget(port)).toEqual(first);
    expect(await requestHttp(probe, port)).toMatchObject({ statusCode: 200 });
    expect(await probe.resolveWebSocketTarget(secondPort)).toBeNull();
    expect(await requestHttp(probe, secondPort)).toBeNull();
    expect(
      await createConfiguredGatewayLocalProbe(configFor(certPath)).resolveWebSocketTarget(port),
    ).toBeNull();
    expect(await probe.resolveWebSocketTarget(port)).toEqual(first);
  });

  test("retains the verified serving pin while another replacement is staged", async () => {
    const request = (pathname: "/healthz" | "/readyz") =>
      requestHttp(probe, port, { pathname, timeoutMs: 3000 });
    expect(await request("/healthz")).toMatchObject({ statusCode: 200 });
    await writeFile(certPath, PROXY_FIXTURE_CERTIFICATE);
    server.setSecureContext({ cert: PROXY_FIXTURE_CERTIFICATE, key: PROXY_FIXTURE_KEY });
    expect(await request("/readyz")).toMatchObject({ statusCode: 200 });
    // Stage a different pin without changing the listener; only its verified replacement may serve.
    await writeFile(certPath, TEST_TLS_CERT_PEM);
    expect(await request("/healthz")).toMatchObject({
      statusCode: 200,
      tlsFingerprint: pin(PROXY_FIXTURE_CERTIFICATE),
    });
    expect(await probe.resolveWebSocketTarget(port)).toEqual({
      url: `wss://127.0.0.1:${port}`,
      tlsFingerprint: pin(PROXY_FIXTURE_CERTIFICATE),
    });
  });
});

test.each(["silent", "dripping"])("bounds a %s native HTTP peer by one deadline", async (mode) => {
  const responseReady = createDeferredCore<http.ServerResponse>();
  const server = http.createServer((_request, response) => {
    responseReady.resolve(response);
  });
  const port = await listen(server);
  const controller = new AbortController();
  // Socket I/O stays native; only the absolute request deadline uses the fake clock.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = requestHttp(createConfiguredGatewayLocalProbe({}), port, {
    timeoutMs: 10,
    signal: controller.signal,
  });
  const outcome = vi.fn();
  const operation = pending.then(outcome, outcome);
  try {
    const response = await Promise.race([
      responseReady.promise,
      pending.then(() => {
        throw new Error("Probe settled before its native HTTP request arrived");
      }),
    ]);
    if (mode === "dripping") {
      const write = async (chunk: string) => {
        await new Promise<void>((resolve, reject) => {
          response.write(chunk, (error) => (error ? reject(error) : resolve()));
        });
        await setImmediate();
      };
      response.writeHead(200, { "content-type": "application/json" });
      await write('{"ok":');
      await vi.advanceTimersByTimeAsync(5);
      expect(outcome).not.toHaveBeenCalled();
      await write("true");
      await vi.advanceTimersByTimeAsync(5);
    } else {
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(outcome).toHaveBeenCalledWith(null);
  } finally {
    controller.abort();
    vi.useRealTimers();
    await Promise.all([close(server), operation]);
  }
});

test("cancels pending readiness requests when the repair budget expires", async () => {
  const server = http.createServer();
  const port = await listen(server);
  const controller = new AbortController();
  const aborted = new Error("repair-budget");
  try {
    const received = once(server, "request");
    const pending = waitForGatewayHttpReadiness({
      attempts: 3,
      deadlineAt: performance.now() + 60_000,
      delayMs: 500,
      port,
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toBe(aborted);
    await received;
    controller.abort(aborted);
    await rejected;
  } finally {
    await close(server);
  }
});

test.each(["http", "websocket"] as const)(
  "local TLS probe preserves %s cancellation when the certificate is unavailable",
  (transport) =>
    withTestDir({ prefix: "openclaw-probe-cancel-" }, async (directory) => {
      const probe = createConfiguredGatewayLocalProbe(
        configFor(path.join(directory, "missing.pem")),
      );
      const controller = new AbortController();
      const reason = new Error("probe canceled");
      controller.abort(reason);
      await expect(
        transport === "http"
          ? requestHttp(probe, 1, { signal: controller.signal })
          : probe.resolveWebSocketTarget(1, controller.signal),
      ).rejects.toBe(reason);
    }),
);
