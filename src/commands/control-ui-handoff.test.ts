import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import type { Socket } from "node:net";
import path from "node:path";
import type { PeerCertificate } from "node:tls";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import * as fetchGuard from "../infra/net/fetch-guard.js";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { resolveControlUiHandoffTarget, waitForControlUiDocument } from "./control-ui-handoff.js";
import { withLoopbackTestServer } from "./loopback-server.test-support.js";

const { fetchConfiguredLocalOriginWithSsrFGuard } = fetchGuard;
const documentUrl = "http://127.0.0.1:18789/dashboard/";
const tempDirs = createTrackedTempDirs();
const openssl = resolveSystemBin("openssl");
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await tempDirs.cleanup();
});
type GuardedDocumentRequest = Parameters<typeof fetchConfiguredLocalOriginWithSsrFGuard>[0];

function guardedResponse(
  status = 200,
  headers: HeadersInit = { "content-type": "text/html; charset=utf-8" },
  body: string | null = null,
) {
  return {
    response: new Response(body, { status, headers }),
    finalUrl: documentUrl,
    release: vi.fn(async () => {}),
  };
}

const htmlHead = () => guardedResponse();

const mockFetch = () => vi.spyOn(fetchGuard, "fetchConfiguredLocalOriginWithSsrFGuard");
const probe = (options: Partial<Parameters<typeof waitForControlUiDocument>[0]> = {}) =>
  waitForControlUiDocument({ url: documentUrl, ...options });
const preparingResponse = () => guardedResponse(503, { "retry-after": "1" });
const unavailable = {
  ready: false,
  reason: "Control UI dashboard is unavailable (HTTP 503).",
  status: 503,
};

function requireDirectTlsConnect(request: GuardedDocumentRequest): Record<string, unknown> {
  if (request.dispatcherPolicy?.mode !== "direct" || !request.dispatcherPolicy.connect) {
    throw new Error("expected pinned Gateway TLS options");
  }
  return request.dispatcherPolicy.connect;
}

const ambientPassword = ["ambient", "password"].join("-");

it("keeps plaintext custom browser and exact-base-path document URLs on loopback", async () => {
  const target = await resolveControlUiHandoffTarget({
    config: {
      gateway: {
        bind: "custom",
        customBindHost: "10.0.0.5",
        controlUi: { basePath: "/dashboard" },
        auth: { token: "shared-test-token" },
      },
    },
    env: {},
  });
  expect(target.links.httpUrl).toBe(documentUrl);
  expect(target).toMatchObject({
    documentUrl,
    probeUrl: "ws://10.0.0.5:18789/dashboard",
    loopbackAliasHost: "10.0.0.5",
    dashboardUrl: `${documentUrl}#token=shared-test-token`,
  });
});

it("blocks implicit token failure", async () => {
  const target = await resolveControlUiHandoffTarget({
    config: {
      gateway: {
        auth: { token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" } },
      },
    },
    env: { OPENCLAW_GATEWAY_TOKEN: "ambient-token", OPENCLAW_GATEWAY_PASSWORD: ambientPassword },
  });
  expect(target).toMatchObject({ authMode: "password", includeTokenInUrl: false });
  expect(target["gatewayAuthHandoff"]).toBeUndefined();
  expect(target.dashboardUrl).not.toContain("ambient-token");
});

it.runIf(openssl)(
  "verifies a CA-signed HTTPS leaf without the issuer or private key and rejects a replacement",
  async () => {
    const root = await tempDirs.make("openclaw-tls-owner-https-");
    const certPath = path.join(root, "leaf.pem");
    const keyPath = path.join(root, "signer.key");
    const caPath = path.join(root, "signer.pem");
    const csrPath = path.join(root, "leaf.csr");
    await fs.writeFile(keyPath, TEST_TLS_KEY_PEM, { mode: 0o600 });
    await fs.writeFile(caPath, TEST_TLS_CERT_PEM);
    const run = promisify(execFile);
    await run(
      openssl!,
      ["req", "-new", "-key", keyPath, "-subj", "/CN=gateway.test", "-out", csrPath],
      { timeout: 10_000 },
    );
    await run(
      openssl!,
      [
        ["x509", "-req"],
        ["-in", csrPath],
        ["-CA", caPath],
        ["-CAkey", keyPath],
        ["-set_serial", "2"],
        ["-days", "1"],
        ["-out", certPath],
      ].flat(),
      { timeout: 10_000 },
    );
    const cert = await fs.readFile(certPath, "utf8");
    await fs.unlink(keyPath);
    await fs.unlink(caPath);
    let requests = 0;
    const server = createServer({ cert, key: TEST_TLS_KEY_PEM }, (_request, response) => {
      requests++;
      response.writeHead(200, { "content-type": "text/html" });
      response.end();
    });
    await withLoopbackTestServer(server, async (port) => {
      const options = {
        url: `https://127.0.0.1:${port}/dashboard/`,
        tlsConfig: { enabled: true, certPath, keyPath, caPath },
      };
      await expect(waitForControlUiDocument(options)).resolves.toMatchObject({ ready: true });
      expect(requests).toBe(1);
      server.closeAllConnections();
      server.setSecureContext({ cert: TEST_TLS_CERT_PEM, key: TEST_TLS_KEY_PEM });
      await expect(waitForControlUiDocument(options)).resolves.toMatchObject({ ready: false });
      expect(requests).toBe(1);
    });
  },
);

it("probes the exact HTML document without credentials or redirects", async () => {
  const response = htmlHead();
  const fetch = mockFetch().mockResolvedValue(response);
  await expect(probe()).resolves.toEqual({ ready: true });
  expect(fetch).toHaveBeenCalledWith(
    expect.objectContaining({
      url: documentUrl,
      configuredLocalOriginBaseUrl: "http://127.0.0.1:18789",
      policy: { allowedOrigins: ["http://127.0.0.1:18789"] },
      maxRedirects: 0,
      capture: false,
      init: { method: "HEAD", headers: { Accept: "text/html", "Accept-Encoding": "identity" } },
    }),
  );
  expect(response.release).toHaveBeenCalledOnce();
});

it("retries only explicitly preparing dashboards before starting the handoff clock", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const preparing = preparingResponse();
  const ready = htmlHead();
  const fetch = mockFetch().mockResolvedValueOnce(preparing).mockResolvedValueOnce(ready);
  const onPending = vi.fn();
  const pending = probe({ onPending });
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toEqual({ ready: true });
  expect(Date.now()).toBe(1_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(onPending).toHaveBeenCalledOnce();
  expect(preparing.release).toHaveBeenCalledOnce();
  expect(ready.release).toHaveBeenCalledOnce();
});

it("fails immediately for JSON consumers while assets are preparing", async () => {
  const preparing = preparingResponse();
  const fetch = mockFetch().mockResolvedValue(preparing);
  const onPending = vi.fn();
  await expect(probe({ waitForPending: false, onPending })).resolves.toEqual({
    ready: false,
    reason: "Control UI assets are still preparing.",
    status: 503,
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(onPending).not.toHaveBeenCalled();
});

it("keeps the observed HTTP failure when the diagnostic request fails", async () => {
  const head = guardedResponse(503, {});
  const fetch = mockFetch()
    .mockResolvedValueOnce(head)
    .mockRejectedValueOnce(new Error("diagnostic request failed"));
  await expect(probe()).resolves.toEqual(unavailable);
  expect(fetch.mock.calls.map(([request]) => request.init?.method)).toEqual(["HEAD", "GET"]);
  expect(head.release).toHaveBeenCalledOnce();
});

it.each(["complete", "broken"] as const)(
  "preserves a real HTTP failure with a %s diagnostic body",
  async (body) => {
    const methods: string[] = [];
    const responses: Array<{ method: string; status: number }> = [];
    const releases: string[] = [];
    const diagnosticSocket = createDeferredCore<Socket>();
    const diagnosticClosed = createDeferredCore();
    await withEnvAsync({ no_proxy: "127.0.0.1" }, async () => {
      const server = createHttpServer((request, response) => {
        methods.push(request.method ?? "");
        response.writeHead(503, { "content-type": "text/plain", connection: "close" });
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        diagnosticSocket.resolve(request.socket);
        request.socket.once("close", () => diagnosticClosed.resolve());
        response.write("Asset build failed");
        if (body === "complete") {
          response.end();
        }
      });
      await withLoopbackTestServer(server, async (port) => {
        mockFetch().mockImplementation(async (request) => {
          const guarded = await fetchConfiguredLocalOriginWithSsrFGuard(request);
          const method = String(request.init?.method);
          responses.push({ method, status: guarded.response.status });
          if (method === "GET" && body === "broken") {
            // Fault the real body only after guarded fetch has delivered its headers.
            (await diagnosticSocket.promise).destroy();
          }
          return {
            ...guarded,
            release: async () => {
              await guarded.release();
              releases.push(method);
            },
          };
        });
        const result = await waitForControlUiDocument({
          url: `http://127.0.0.1:${port}/dashboard/`,
        });
        await diagnosticClosed.promise;

        expect(result).toEqual({
          ready: false,
          reason:
            body === "complete"
              ? "Asset build failed"
              : "Control UI dashboard is unavailable (HTTP 503).",
          status: 503,
        });
        expect(methods).toEqual(["HEAD", "GET"]);
        expect(responses).toEqual([
          { method: "HEAD", status: 503 },
          { method: "GET", status: 503 },
        ]);
        // Observe release and socket closure before the server fixture teardown.
        expect(releases).toEqual(["GET", "HEAD"]);
      });
    });
  },
);

it("does not expose HTML when a terminal failure becomes ready during diagnostic fetch", async () => {
  const head = guardedResponse(503, {});
  const repaired = guardedResponse(
    200,
    { "content-type": "text/html" },
    "<html>private-looking UI content</html>",
  );
  mockFetch().mockResolvedValueOnce(head).mockResolvedValueOnce(repaired);
  await expect(probe()).resolves.toEqual(unavailable);
});

it("bounds the independent preparing deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const fetch = mockFetch().mockImplementation(async () => preparingResponse());
  const pending = probe({ timeoutMs: 2_500 });
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toEqual({
    ready: false,
    reason: "Control UI assets did not finish preparing in time.",
  });
  expect(Date.now()).toBe(2_500);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("trusts the public certificate and rejects a different peer without reading a server CA", async () => {
  const root = await tempDirs.make("openclaw-tls-owner-dashboard-");
  const certPath = path.join(root, "cert.pem");
  await fs.writeFile(certPath, TEST_TLS_CERT_PEM);
  const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
  const fetch = mockFetch().mockImplementation(async (_request: GuardedDocumentRequest) =>
    htmlHead(),
  );
  const options = {
    url: "https://127.0.0.1:32123/dashboard/",
    tlsConfig: { enabled: true, certPath },
  };
  await expect(
    waitForControlUiDocument({
      ...options,
      tlsConfig: { ...options.tlsConfig, caPath: path.join(root, "absent-ca.pem") },
    }),
  ).resolves.toEqual({ ready: true, tlsFingerprint: fingerprint });
  const [request] = fetch.mock.calls[0] ?? [];
  if (!request) {
    throw new Error("expected dashboard TLS request");
  }
  const connect = requireDirectTlsConnect(request);
  expect(connect.ca).toBe(TEST_TLS_CERT_PEM);
  expect(connect).not.toHaveProperty("rejectUnauthorized");
  const check = connect.checkServerIdentity as (
    hostname: string,
    certificate: PeerCertificate,
  ) => Error | undefined;
  expect(check("127.0.0.1", { fingerprint256: fingerprint } as PeerCertificate)).toBeUndefined();
  expect(check("127.0.0.1", { fingerprint256: "cd".repeat(32) } as PeerCertificate)).toEqual(
    new Error("Gateway TLS certificate fingerprint mismatch."),
  );
  fetch.mockImplementation(async () => {
    const mismatch = check("127.0.0.1", { fingerprint256: "cd".repeat(32) } as PeerCertificate);
    if (mismatch) {
      throw mismatch;
    }
    return htmlHead();
  });
  await expect(waitForControlUiDocument(options)).resolves.toEqual({
    ready: false,
    reason: "Control UI dashboard is unavailable: Gateway TLS certificate fingerprint mismatch.",
  });
});
