import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import type { Socket } from "node:net";
import path from "node:path";
import type { PeerCertificate, checkServerIdentity } from "node:tls";
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

const mockFetch = () => vi.spyOn(fetchGuard, "fetchConfiguredLocalOriginWithSsrFGuard");
const probe = (options: Partial<Parameters<typeof waitForControlUiDocument>[0]> = {}) =>
  waitForControlUiDocument({ url: documentUrl, ...options });
const preparingResponse = () => guardedResponse(503, { "retry-after": "1" });
const unavailable = {
  ready: false,
  reason: "Control UI dashboard is unavailable (HTTP 503).",
  status: 503,
};

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
  expect(target).toMatchObject({
    links: { httpUrl: documentUrl },
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
    env: { OPENCLAW_GATEWAY_TOKEN: "ambient-token", OPENCLAW_GATEWAY_PASSWORD: "ambient-password" },
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
    const run = (...args: string[]) => promisify(execFile)(openssl!, args, { timeout: 10_000 });
    await run("req", "-new", "-key", keyPath, "-subj", "/CN=gateway.test", "-out", csrPath);
    await run(
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      caPath,
      "-CAkey",
      keyPath,
      "-set_serial",
      "2",
      "-days",
      "1",
      "-out",
      certPath,
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
  const response = guardedResponse();
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

it.each(["ready", "abort", "immediate"])("handles preparing dashboards: %s", async (outcome) => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const preparing = preparingResponse();
  const ready = guardedResponse();
  const fetch = mockFetch().mockResolvedValueOnce(preparing).mockResolvedValue(ready);
  const controller = new AbortController();
  const onPending = vi.fn(() => outcome === "abort" && controller.abort());
  const pending = probe({
    onPending,
    timeoutMs: 2_500,
    waitForPending: outcome !== "immediate",
    signal: controller.signal,
  });
  await vi.runAllTimersAsync();
  const expected =
    outcome === "ready"
      ? { ready: true }
      : {
          ready: false,
          reason:
            outcome === "immediate"
              ? "Control UI assets are still preparing."
              : "Control UI readiness check was interrupted.",
          ...(outcome === "immediate" ? { status: 503 } : {}),
        };
  await expect(pending).resolves.toEqual(expected);
  expect(Date.now()).toBe(outcome === "ready" ? 1_000 : 0);
  expect(fetch).toHaveBeenCalledTimes(outcome === "ready" ? 2 : 1);
  expect(onPending).toHaveBeenCalledTimes(outcome === "immediate" ? 0 : 1);
  expect(preparing.release).toHaveBeenCalledOnce();
});

it("retries a real document timeout and reports pending once", async () => {
  let requests = 0;
  const onPending = vi.fn();
  const server = createHttpServer((_request, response) => {
    requests++;
    if (requests > 1) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end();
    }
  });
  await withEnvAsync({ no_proxy: "127.0.0.1" }, async () => {
    await withLoopbackTestServer(server, async (port) => {
      await expect(
        waitForControlUiDocument({
          url: `http://127.0.0.1:${port}/dashboard/`,
          timeoutMs: 15_000,
          onPending,
        }),
      ).resolves.toEqual({ ready: true });
    });
  });
  expect(requests).toBe(2);
  expect(onPending).toHaveBeenCalledOnce();
}, 20_000);

it.each(["timeout", "preparing"])(
  "reports the latest pending state at the deadline: %s",
  async (state) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const timeout = new Error("request timed out");
    timeout.name = "TimeoutError";
    const fetch = mockFetch().mockRejectedValueOnce(timeout);
    if (state === "preparing") {
      fetch.mockImplementation(async () => preparingResponse());
    } else {
      fetch.mockRejectedValue(timeout);
    }
    const onPending = vi.fn();
    const pending = probe({ onPending, timeoutMs: 5_000 });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({
      ready: false,
      reason:
        state === "timeout"
          ? "Control UI dashboard is unavailable: request timed out"
          : "Control UI assets did not finish preparing in time.",
    });
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    expect(onPending).toHaveBeenCalledOnce();
  },
);

it("fails fast on a transient timeout when the caller skips pending waits", async () => {
  const timeout = new Error("request timed out");
  timeout.name = "TimeoutError";
  const fetch = mockFetch().mockRejectedValueOnce(timeout);
  await expect(probe({ timeoutMs: 5_000, waitForPending: false })).resolves.toEqual({
    ready: false,
    reason: "Control UI dashboard is unavailable: request timed out",
  });
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(["fails", "becomes HTML"])("keeps HTTP failure: diagnostic %s", async (outcome) => {
  const head = guardedResponse(503, {});
  const fetch = mockFetch().mockResolvedValueOnce(head);
  if (outcome === "fails") {
    fetch.mockRejectedValueOnce(new Error("diagnostic request failed"));
  } else {
    fetch.mockResolvedValueOnce(
      guardedResponse(200, { "content-type": "text/html" }, "private UI"),
    );
  }
  await expect(probe()).resolves.toEqual(unavailable);
  expect(fetch.mock.calls.map(([request]) => request.init?.method)).toEqual(["HEAD", "GET"]);
  expect(head.release).toHaveBeenCalledOnce();
});

it.each(["complete", "broken"] as const)(
  "preserves a real HTTP failure with a %s diagnostic body",
  async (body) => {
    const methods: string[] = [];
    const responses: string[] = [];
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
          responses.push(`${method}:${guarded.response.status}`);
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
        expect(responses).toEqual(["HEAD:503", "GET:503"]);
        // Observe release and socket closure before the server fixture teardown.
        expect(releases).toEqual(["GET", "HEAD"]);
      });
    });
  },
);

it("trusts the public certificate and rejects a different peer without reading a server CA", async () => {
  const root = await tempDirs.make("openclaw-tls-owner-dashboard-");
  const certPath = path.join(root, "cert.pem");
  await fs.writeFile(certPath, TEST_TLS_CERT_PEM);
  const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
  const fetch = mockFetch().mockImplementation(async () => guardedResponse());
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
  const request = fetch.mock.calls[0]?.[0];
  if (request?.dispatcherPolicy?.mode !== "direct" || !request.dispatcherPolicy.connect) {
    throw new Error("expected pinned Gateway TLS options");
  }
  const connect = request.dispatcherPolicy.connect;
  expect(connect.ca).toBe(TEST_TLS_CERT_PEM);
  expect(connect).not.toHaveProperty("rejectUnauthorized");
  const check = connect.checkServerIdentity as typeof checkServerIdentity;
  expect(check("127.0.0.1", { fingerprint256: fingerprint } as PeerCertificate)).toBeUndefined();
  const mismatch = check("127.0.0.1", { fingerprint256: "cd".repeat(32) } as PeerCertificate);
  expect(mismatch).toEqual(new Error("Gateway TLS certificate fingerprint mismatch."));
  fetch.mockRejectedValue(mismatch);
  await expect(waitForControlUiDocument(options)).resolves.toEqual({
    ready: false,
    reason: "Control UI dashboard is unavailable: Gateway TLS certificate fingerprint mismatch.",
  });
});
