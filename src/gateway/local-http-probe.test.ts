import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { waitForGatewayHttpReadiness } from "../cli/daemon-cli/restart-health-probe.js";
import { loadGatewayTlsServerRuntime } from "../infra/tls/gateway.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  createConfiguredGatewayLocalProbe,
  requestGatewayLocalHttpProbe,
} from "./local-http-probe.js";

const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;

test("probes configured local TLS readiness with its exact certificate pin", async () => {
  await withTestDir({ prefix: "openclaw-local-http-probe-" }, async (directory) => {
    const certPath = path.join(directory, "gateway-cert.pem");
    const keyPath = path.join(directory, "gateway-key.pem");
    // Client probes need only the public certificate; the configured private key is absent.
    await writeFile(certPath, TEST_TLS_CERT_PEM);
    const paths: string[] = [];
    const server = createServer(
      { cert: TEST_TLS_CERT_PEM, key: TEST_TLS_KEY_PEM },
      (request, response) => {
        paths.push(request.url ?? "");
        response.statusCode = 200;
        response.end(JSON.stringify({ ready: request.url === "/readyz" }));
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;

    try {
      const probe = createConfiguredGatewayLocalProbe({
        gateway: { tls: { enabled: true, autoGenerate: false, certPath, keyPath } },
      });
      const config = {
        gateway: { tls: { enabled: true, autoGenerate: false, certPath, keyPath } },
      };
      await expect(
        waitForGatewayHttpReadiness({
          attempts: 1,
          config,
          deadlineAt: Date.now() + 1_000,
          delayMs: 0,
          port: address.port,
        }),
      ).resolves.toEqual({ healthz: 200, readyz: 200 });
      expect(paths).toEqual(expect.arrayContaining(["/healthz", "/readyz"]));
      await expect(
        probe.requestHttp({
          host: "127.0.0.1",
          pathname: "/readyz",
          port: address.port,
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ statusCode: 200, body: JSON.stringify({ ready: true }) });
      await expect(
        requestGatewayLocalHttpProbe({
          host: "127.0.0.1",
          pathname: "/readyz",
          port: address.port,
          timeoutMs: 1_000,
          tlsFingerprints: [fingerprint.replace(/[\dA-F]/g, "0")],
        }),
      ).resolves.toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

test("cancels pending readiness requests when the repair budget expires", async () => {
  const server = createHttpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP listener");
  }
  const controller = new AbortController();
  const aborted = new Error("repair-budget");
  try {
    const received = once(server, "request");
    const pending = waitForGatewayHttpReadiness({
      attempts: 3,
      deadlineAt: Date.now() + 60_000,
      delayMs: 500,
      port: address.port,
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toBe(aborted);
    await received;
    controller.abort(aborted);
    await rejected;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

test("keeps a WebSocket-first verified pin scoped to its endpoint", async () => {
  await withTestDir({ prefix: "openclaw-probe-pin-owner-" }, async (directory) => {
    const certPath = path.join(directory, "cert.pem");
    await writeFile(certPath, TEST_TLS_CERT_PEM);
    const servers = [0, 1].map(() =>
      createServer({ cert: TEST_TLS_CERT_PEM, key: TEST_TLS_KEY_PEM }, (_request, response) => {
        response.end('{"ok":true,"status":"live"}');
      }),
    );
    try {
      const ports = await Promise.all(
        servers.map(async (server) => {
          server.listen(0, "127.0.0.1");
          await once(server, "listening");
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Expected an ephemeral TLS listener");
          }
          return address.port;
        }),
      );
      const [firstPort, secondPort] = ports;
      if (firstPort === undefined || secondPort === undefined) {
        throw new Error("Expected two TLS listener ports");
      }
      const config = { gateway: { tls: { enabled: true, certPath } } };
      const probe = createConfiguredGatewayLocalProbe(config);
      const first = await probe.resolveWebSocketTarget(firstPort);
      expect(first).toEqual({
        url: `wss://127.0.0.1:${firstPort}`,
        tlsFingerprint: fingerprint.replaceAll(":", "").toLowerCase(),
      });
      await unlink(certPath);
      expect(await probe.resolveWebSocketTarget(firstPort)).toEqual(first);
      expect(
        await probe.requestHttp({
          host: "127.0.0.1",
          port: firstPort,
          pathname: "/healthz",
          timeoutMs: 1000,
        }),
      ).toMatchObject({ statusCode: 200 });
      expect(await probe.resolveWebSocketTarget(secondPort)).toBeNull();
      expect(
        await probe.requestHttp({
          host: "127.0.0.1",
          port: secondPort,
          pathname: "/healthz",
          timeoutMs: 1000,
        }),
      ).toBeNull();
      expect(
        await createConfiguredGatewayLocalProbe(config).resolveWebSocketTarget(firstPort),
      ).toBeNull();
      expect(await probe.resolveWebSocketTarget(firstPort)).toEqual(first);
    } finally {
      await Promise.all(
        servers.map(async (server) => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
        }),
      );
    }
  });
});

test.each([
  { cache: "warm", completion: "old-first" },
  { cache: "warm", completion: "new-first" },
  { cache: "cold", completion: "old-first" },
  { cache: "cold", completion: "new-first" },
] as const)(
  "retains the verified replacement after concurrent probes ($cache, $completion)",
  async ({ cache, completion }) => {
    await withTestDir({ prefix: "openclaw-probe-concurrent-renewal-" }, async (directory) => {
      const [replacement, staged] = await Promise.all(
        ["replacement", "staged"].map((name) =>
          loadGatewayTlsServerRuntime({
            enabled: true,
            certPath: path.join(directory, name, "cert.pem"),
            keyPath: path.join(directory, name, "key.pem"),
          }),
        ),
      );
      if (!replacement?.tlsOptions || !replacement.certPath || !staged?.certPath) {
        throw new Error("Expected complete synthetic TLS pairs");
      }
      const certPath = path.join(directory, "current.pem");
      await writeFile(certPath, TEST_TLS_CERT_PEM);
      const oldResponse = createDeferredCore<ServerResponse>();
      const newResponse = createDeferredCore<ServerResponse>();
      let hold = false;
      const server = createServer(
        { cert: TEST_TLS_CERT_PEM, key: TEST_TLS_KEY_PEM },
        (request, response) => {
          if (hold) {
            (request.url === "/healthz" ? oldResponse : newResponse).resolve(response);
          } else {
            response.end('{"ok":true,"status":"live"}');
          }
        },
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected an ephemeral TLS listener");
        }
        const port = address.port;
        const probe = createConfiguredGatewayLocalProbe({
          gateway: { tls: { enabled: true, certPath } },
        });
        const request = (pathname: "/healthz" | "/readyz") =>
          probe.requestHttp({ host: "127.0.0.1", port, pathname, timeoutMs: 3000 });
        if (cache === "warm") {
          expect(await request("/healthz")).toMatchObject({ statusCode: 200 });
        }
        hold = true;
        const oldRequest = request("/healthz");
        const old = await oldResponse.promise;
        await writeFile(certPath, await readFile(replacement.certPath));
        server.setSecureContext(replacement.tlsOptions);
        const newRequest = request("/readyz");
        const next = await newResponse.promise;
        const responses =
          completion === "old-first"
            ? ([
                [old, oldRequest],
                [next, newRequest],
              ] as const)
            : ([
                [next, newRequest],
                [old, oldRequest],
              ] as const);
        for (const [response, pending] of responses) {
          response.end('{"ok":true,"status":"live"}');
          expect(await pending).toMatchObject({ statusCode: 200 });
        }
        hold = false;
        await writeFile(certPath, await readFile(staged.certPath));
        expect(await request("/healthz")).toMatchObject({
          statusCode: 200,
          tlsFingerprint: replacement.fingerprintSha256,
        });
        expect(await probe.resolveWebSocketTarget(port)).toEqual({
          url: `wss://127.0.0.1:${port}`,
          tlsFingerprint: replacement.fingerprintSha256,
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    });
  },
);

describe("local TLS probe cancellation", () => {
  test.each(["http", "websocket"] as const)(
    "preserves %s cancellation when the certificate is unavailable",
    async (transport) => {
      await withTestDir({ prefix: "openclaw-probe-cancel-" }, async (directory) => {
        const probe = createConfiguredGatewayLocalProbe({
          gateway: { tls: { enabled: true, certPath: path.join(directory, "missing.pem") } },
        });
        const controller = new AbortController();
        const reason = new Error("probe canceled");
        controller.abort(reason);
        const result =
          transport === "http"
            ? probe.requestHttp({
                host: "127.0.0.1",
                port: 1,
                pathname: "/healthz",
                timeoutMs: 1000,
                signal: controller.signal,
              })
            : probe.resolveWebSocketTarget(1, controller.signal);
        await expect(result).rejects.toBe(reason);
      });
    },
  );
});
