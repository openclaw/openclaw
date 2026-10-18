import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { unlink, writeFile } from "node:fs/promises";
import * as http from "node:http";
import { createServer } from "node:https";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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

  test.each([
    { cache: "warm", completion: "old-first" },
    { cache: "warm", completion: "new-first" },
    { cache: "cold", completion: "old-first" },
    { cache: "cold", completion: "new-first" },
  ] as const)(
    "retains the verified replacement after concurrent probes ($cache, $completion)",
    async ({ cache, completion }) => {
      const oldResponse = createDeferredCore<http.ServerResponse>();
      const newResponse = createDeferredCore<http.ServerResponse>();
      let hold = false;
      handler = (request, response) => {
        if (hold) {
          (request.url === "/healthz" ? oldResponse : newResponse).resolve(response);
        } else {
          response.end(liveBody);
        }
      };
      const request = (pathname: "/healthz" | "/readyz") =>
        requestHttp(probe, port, { pathname, timeoutMs: 3000 });
      if (cache === "warm") {
        expect(await request("/healthz")).toMatchObject({ statusCode: 200 });
      }
      hold = true;
      const oldRequest = request("/healthz");
      const old = await oldResponse.promise;
      await writeFile(certPath, PROXY_FIXTURE_CERTIFICATE);
      server.setSecureContext({ cert: PROXY_FIXTURE_CERTIFICATE, key: PROXY_FIXTURE_KEY });
      const newRequest = request("/readyz");
      const next = await newResponse.promise;
      const responses = [
        [old, oldRequest],
        [next, newRequest],
      ] as const;
      for (const [response, pending] of completion === "old-first"
        ? responses
        : responses.toReversed()) {
        response.end(liveBody);
        expect(await pending).toMatchObject({ statusCode: 200 });
      }
      hold = false;
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
    },
  );
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
