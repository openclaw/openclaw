import { request as httpRequest, type RequestOptions } from "node:http";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createGatewayAuthRateLimiter } from "./auth-rate-limit.js";
import { createGatewayRuntimeStateForTest } from "./test-helpers.server-runtime-state.js";

type Runtime = Awaited<ReturnType<typeof createGatewayRuntimeStateForTest>>;
const getReadiness = () => ({ ready: true, failing: [], uptimeMs: 1 });
const forwardedHeaders = {
  "x-forwarded-for": "203.0.113.10",
  "x-forwarded-proto": "https",
  "x-forwarded-host": "gateway.example",
};

async function createRuntime(...args: Parameters<typeof createGatewayRuntimeStateForTest>) {
  const runtime = await createGatewayRuntimeStateForTest(...args);
  onTestFinished(() => {
    runtime.wss.close();
  });
  return runtime;
}

function ordinaryEndpoint(runtime: Runtime) {
  const address = runtime.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("expected ordinary gateway listener");
  }
  return { host: "127.0.0.1", port: address.port };
}

function managedEndpoint(runtime: Runtime) {
  const endpoint = runtime.getTailscaleIngressEndpoint();
  if (!endpoint) {
    throw new Error("expected managed gateway listener");
  }
  return endpoint;
}

type Endpoint = Pick<RequestOptions, "host" | "port">;
type Response = { status: number; body: string };
async function requestStatus(
  endpoint: Endpoint,
  path: string,
  headers?: Record<string, string>,
  upgrade = false,
): Promise<Response> {
  const requestHeaders = upgrade
    ? {
        ...headers,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      }
    : headers;
  return await new Promise((resolve, reject) => {
    const req = httpRequest({ ...endpoint, path, headers: requestHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.once("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    if (upgrade) {
      req.setTimeout(2_000, () => req.destroy(new Error("upgrade rejection timed out")));
    }
    req.once("upgrade", (res, socket, head) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, body: head.toString("utf8") });
    });
    req.once("error", reject);
    req.end();
  });
}

describe("managed Tailscale gateway ingress", () => {
  it("keeps ordinary ingress closed until the managed route is claimed", async () => {
    const { promise: routeClaim, resolve: releaseRouteClaim } = createDeferred();
    const prepareManagedTailscaleIngress = vi.fn(async () => await routeClaim);
    const runtime = await createRuntime(undefined, {
      tailscaleMode: "serve",
      prepareManagedTailscaleIngress,
    });

    const starting = runtime.startListening();
    await vi.waitFor(() => expect(prepareManagedTailscaleIngress).toHaveBeenCalledOnce());

    expect(runtime.getTailscaleIngressEndpoint()).toMatchObject({ host: "127.0.0.1" });
    expect(runtime.httpServer.listening).toBe(false);

    releaseRouteClaim();
    await starting;
    expect(runtime.httpServer.listening).toBe(true);
  });

  it("binds a distinct private listener and rejects the same headers on the ordinary listener", async () => {
    const runtime = await createRuntime(undefined, {
      tailscaleMode: "serve",
      getReadiness,
    });
    await runtime.startListening();
    const ordinaryAddress = ordinaryEndpoint(runtime);
    const tailscaleAddress = managedEndpoint(runtime);
    expect(tailscaleAddress.host).toBe("127.0.0.1");
    expect(tailscaleAddress.port).not.toBe(ordinaryAddress.port);

    const headers = {
      "x-forwarded-for": "100.64.0.10",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "gateway.tailnet.ts.net",
    };
    const ordinaryResponses = await Promise.all(
      ["/ready", "/v1/models", "/api/users/profile-1/avatar"].map((path) =>
        requestStatus(ordinaryAddress, path, headers),
      ),
    );
    const managed = await requestStatus(tailscaleAddress, "/ready", headers);

    for (const ordinary of ordinaryResponses) {
      expect(ordinary).toMatchObject({ status: 403 });
      expect(ordinary.body).toContain("proxy_attribution_required");
    }
    expect(managed.status).toBe(200);
  });

  it("accepts tailnet and public ingress on the dedicated Funnel listener", async () => {
    const runtime = await createRuntime(undefined, {
      tailscaleMode: "funnel",
      getReadiness,
    });
    await runtime.startListening();
    const endpoint = managedEndpoint(runtime);

    const missingMarker = await requestStatus(endpoint, "/ready", forwardedHeaders);
    const marked = await requestStatus(endpoint, "/ready", {
      ...forwardedHeaders,
      "tailscale-funnel-request": "?1",
    });
    const malformedMarker = await requestStatus(endpoint, "/ready", {
      ...forwardedHeaders,
      "tailscale-funnel-request": "true",
    });

    expect([missingMarker.status, marked.status, malformedMarker.status]).toEqual([200, 200, 403]);
  });

  it("rejects external Funnel ingress when gateway auth is disabled", async () => {
    const auth = { mode: "none" as const, allowTailscale: false };
    const runtime = await createRuntime(undefined, {
      cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
      openAiChatCompletionsEnabled: true,
      resolvedAuth: auth,
      getResolvedAuth: () => auth,
    });
    await runtime.startListening();
    const endpoint = ordinaryEndpoint(runtime);

    await expect(
      requestStatus(endpoint, "/v1/models", {
        ...forwardedHeaders,
        "tailscale-funnel-request": "?1",
      }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(requestStatus(endpoint, "/v1/models")).resolves.toMatchObject({
      status: 200,
    });
  });

  it("isolates protected Funnel auth lockout by the validated source", async () => {
    const limiter = createGatewayAuthRateLimiter(
      {
        maxAttempts: 1,
        windowMs: 60_000,
        lockoutMs: 60_000,
        pruneIntervalMs: 0,
      },
      { scheduler: createTestGatewayScheduler() },
    );
    onTestFinished(() => limiter.dispose());
    const auth = { mode: "token" as const, token: "secret", allowTailscale: false };
    const runtime = await createRuntime(undefined, {
      tailscaleMode: "funnel",
      openAiChatCompletionsEnabled: true,
      resolvedAuth: auth,
      getResolvedAuth: () => auth,
      rateLimiter: limiter,
    });
    await runtime.startListening();
    const ordinaryAddress = ordinaryEndpoint(runtime);
    const endpoint = managedEndpoint(runtime);
    const requestFrom = (clientIp: string, token: string) =>
      requestStatus(endpoint, "/v1/models", {
        authorization: `Bearer ${token}`,
        ...forwardedHeaders,
        "x-forwarded-for": clientIp,
        "tailscale-funnel-request": "?1",
      });

    await expect(requestFrom("203.0.113.10", "wrong")).resolves.toMatchObject({ status: 401 });
    await expect(requestFrom("203.0.113.10", "secret")).resolves.toMatchObject({ status: 429 });
    await expect(requestFrom("203.0.113.11", "secret")).resolves.toMatchObject({ status: 200 });
    await expect(
      requestStatus(ordinaryAddress, "/v1/models", { authorization: "Bearer secret" }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("routes proxy-shaped WebSocket upgrades only to plugin-authenticated routes", async () => {
    const registry = createEmptyPluginRegistry();
    const observedClient = vi.fn();
    registry.httpRoutes.push({
      path: "/plugin-ws",
      auth: "plugin",
      match: "exact",
      handler: () => false,
      handleUpgrade: (req, socket) => {
        observedClient({
          remoteAddress: req.socket.remoteAddress,
          clientIp: getPluginRuntimeGatewayRequestScope()?.client?.clientIp,
        });
        socket.end(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
        return true;
      },
      pluginId: "plugin-ws",
      source: "test",
    });
    const runtime = await createRuntime(registry, {
      tailscaleMode: "serve",
      getReadiness,
    });
    await runtime.startListening();
    const ordinaryAddress = ordinaryEndpoint(runtime);
    const proxyHeaders = { ...forwardedHeaders, "x-forwarded-for": "198.51.100.20" };

    await expect(
      requestStatus(ordinaryAddress, "/plugin-ws", proxyHeaders, true),
    ).resolves.toMatchObject({ status: 101 });
    expect(observedClient).toHaveBeenCalledWith({
      remoteAddress: "127.0.0.1",
      clientIp: "127.0.0.1",
    });
    expect(observedClient).not.toHaveBeenCalledWith(
      expect.objectContaining({ clientIp: "198.51.100.20" }),
    );

    const rejectedGatewayUpgrade = await requestStatus(
      ordinaryAddress,
      "/ready",
      proxyHeaders,
      true,
    );
    expect(rejectedGatewayUpgrade.status).toBe(403);
    expect(rejectedGatewayUpgrade.body).toContain("proxy_attribution_required");
  });
});
