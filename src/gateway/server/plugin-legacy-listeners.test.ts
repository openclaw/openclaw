import { once } from "node:events";
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { text } from "node:stream/consumers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getWebhookLegacyListener } from "../../plugin-sdk/webhook-ingress.js";
import { readRequestBodyWithLimit } from "../../plugin-sdk/webhook-request-guards.js";
import { createPluginRuntimeCapabilityLease } from "../../plugins/capability-lease.js";
import {
  adoptPluginHttpRouteHandoffs,
  createPluginHttpRouteHandoff,
  registerPluginHttpRoute,
  withPluginHttpRouteRegistry,
} from "../../plugins/http-registry.js";
import { notifyPluginHttpRoutesChanged } from "../../plugins/http-route-owner.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { acquireTestPortBlock, type TestPortClaim } from "../../test-utils/port-claims.js";
import { createGatewayHttpServer } from "../server-http.js";
import { startPluginLegacyListeners } from "./plugin-legacy-listeners.js";
import { createGatewayPluginRequestHandler } from "./plugins-http.js";
import {
  isPluginAuthenticatedRoutePath,
  shouldEnforceGatewayAuthForPluginPath,
} from "./plugins-http/route-auth.js";

describe("legacy channel webhook ports", () => {
  let claim: TestPortClaim;
  let gatewayServer: Server;
  let stop: () => void;
  let registry = createEmptyPluginRegistry();
  const httpServers: Server[] = [];
  const cleanups: Array<() => void> = [];
  const warn = vi.fn();
  const endpoint = (offset: number) => ({ port: claim.port + offset, host: "127.0.0.1" });
  const start = () =>
    startPluginLegacyListeners({ gatewayServer, httpServers, getRegistry: () => registry, warn });
  const close = (server: Server) =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  const retire = async (server: Server, unregister: () => void) => {
    const closed = once(server, "close");
    unregister();
    await closed;
  };
  const park = (lease: ReturnType<typeof createPluginRuntimeCapabilityLease>) => {
    const handoff = createPluginHttpRouteHandoff();
    cleanups.push(handoff.release);
    handoff.park(lease);
    lease.revoke();
    return handoff;
  };
  const restrictedTimeouts = { headersTimeout: 15_000, requestTimeout: 30_000, timeout: 30_000 };
  const signedHeaders = { "x-webhook-secret": "synthetic-secret" };
  const forwardedHeaders = {
    "x-forwarded-for": "203.0.113.20",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "callbacks.example",
  };
  const verifiedCallback =
    (
      handler: Parameters<typeof registerPluginHttpRoute>[0]["handler"],
      path = "/webhook",
    ): typeof handler =>
    (req, res) => {
      if (req.url !== path) {
        res.writeHead(404).end();
        return;
      }
      if (req.headers["x-webhook-secret"] !== signedHeaders["x-webhook-secret"]) {
        res.writeHead(401).end();
        return;
      }
      return handler(req, res);
    };

  beforeAll(async () => {
    claim = await acquireTestPortBlock({ offsets: [0, 1, 2] });
    gatewayServer = createGatewayHttpServer({
      clients: new Set(),
      controlUiEnabled: false,
      controlUiBasePath: "/",
      handleHooksRequest: async () => false,
      resolvedAuth: { mode: "token", token: "synthetic-gateway-token", allowTailscale: false },
      getRuntimeConfig: () => ({ gateway: { trustedProxies: [] } }),
      handlePluginRequest: createGatewayPluginRequestHandler({
        registry,
        getRouteRegistry: () => registry,
        log: createSubsystemLogger("legacy-webhook-test"),
      }),
      shouldEnforcePluginGatewayAuth: (context) =>
        shouldEnforceGatewayAuthForPluginPath(registry, context),
      isPluginAuthenticatedRoute: (context) => isPluginAuthenticatedRoutePath(registry, context),
    });
    gatewayServer.listen(claim.port, "127.0.0.1");
    await once(gatewayServer, "listening");
    httpServers.push(gatewayServer);
    stop = start();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      cleanup();
    }
    registry = createEmptyPluginRegistry();
    const closed = httpServers.slice(1).map((server) => once(server, "close"));
    notifyPluginHttpRoutesChanged();
    await Promise.all(closed);
    resetGatewayWorkAdmission();
    warn.mockClear();
  });

  afterAll(async () => {
    stop();
    gatewayServer.closeAllConnections();
    await close(gatewayServer);
    await claim.release();
  });

  type Route = Partial<Parameters<typeof registerPluginHttpRoute>[0]>;
  const register = (params: Route = {}, offset = 1) => {
    const unregister = registerPluginHttpRoute({
      registry,
      path: "/webhook",
      pluginId: "demo",
      source: "webhook",
      auth: "plugin",
      reuseExistingSameOwner: true,
      ...(offset === 0 ? {} : { legacyListener: endpoint(offset) }),
      handler: (req, res) => {
        if (req.url !== (params.path ?? "/webhook")) {
          res.writeHead(404).end();
          return;
        }
        res.end("accepted");
      },
      ...params,
    });
    cleanups.push(unregister);
    return unregister;
  };

  const listening = async () => {
    // Registration publications coalesce in one microtask; socket readiness is event-driven.
    await Promise.resolve();
    await Promise.all(
      httpServers
        .slice(1)
        .filter((server) => !server.listening)
        .map((server) => once(server, "listening")),
    );
  };

  type RequestOptions = { method?: string; headers?: Record<string, string>; body?: string };
  const send = (offset: number, path = "/webhook", options: RequestOptions = {}) =>
    new Promise<{
      status: number | undefined;
      headers: IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const req = request(
        {
          // Probe the listener with a new connection, never a pooled retired socket.
          agent: false,
          host: "127.0.0.1",
          port: claim.port + offset,
          path,
          method: options.method ?? "GET",
          headers: { Connection: "close", ...options.headers },
        },
        (res) => {
          void text(res).then((body) => {
            resolve({ status: res.statusCode, headers: res.headers, body });
          }, reject);
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
  const accepted = { status: 200, body: "accepted" };
  const expectReply = async (
    reply: ReturnType<typeof send>,
    expected: Partial<Awaited<ReturnType<typeof send>>> = accepted,
  ) => {
    const response = await reply;
    expect(response).toMatchObject(expected);
    return response;
  };
  const expectProfile = async (server: Server, contentType?: string) => {
    expect(httpServers.slice(1)).toEqual([server]);
    expect(server).toMatchObject(
      contentType
        ? { headersTimeout: 60_000, requestTimeout: 300_000, timeout: 0, keepAliveTimeout: 5_000 }
        : restrictedTimeouts,
    );
    const response = await expectReply(send(1, "/healthz"), { status: 200, body: "ok" });
    expect(response.headers["content-type"]).toBe(contentType);
  };

  it.each([undefined, "text/plain"])(
    "preserves the legacy health response with Content-Type %s without changing Gateway probes",
    async (contentType) => {
      const handler = vi.fn((req: IncomingMessage, res: ServerResponse) => {
        expect(getWebhookLegacyListener(req)).toEqual(endpoint(1));
        res.writeHead(404).end();
      });
      register({
        legacyListener: { ...endpoint(1), health: { path: "/healthz", contentType } },
        handler,
      });
      register({ path: "/no-health" }, 2);
      await listening();

      for (const method of ["GET", "HEAD", "OPTIONS", "POST"]) {
        const response = await send(1, "/healthz", { method });
        expect(response).toEqual({
          status: 200,
          body: method === "HEAD" ? "" : "ok",
          headers: {
            date: expect.any(String),
            connection: "close",
            ...(contentType ? { "content-type": contentType } : {}),
            ...(method === "HEAD" ? {} : { "transfer-encoding": "chunked" }),
          },
        });
      }
      expect(handler).not.toHaveBeenCalled();
      for (const path of ["/healthz?probe=1", "/healthz/", "/HEALTHZ", "/%68ealthz"]) {
        const response = await send(1, path);
        expect(response, path).toMatchObject({ status: 404, body: "" });
        expect(response.headers, path).not.toHaveProperty("content-type");
      }
      expect(handler).toHaveBeenCalledTimes(4);
      await expectReply(send(2, "/healthz"), { status: 404, body: "" });

      const gateway = await send(0, "/healthz");
      expect(gateway.status).toBe(200);
      expect(JSON.parse(gateway.body)).toEqual({ ok: true, status: "live" });
      expect(gateway.headers).toMatchObject({
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      await expectReply(send(0, "/healthz", { method: "OPTIONS" }), {
        status: 405,
        body: "Method Not Allowed",
        headers: { allow: "GET, HEAD" },
      });
    },
  );

  it("requires compatible live profiles and replaces a retained handoff profile without reopening its port", async () => {
    const lease = createPluginRuntimeCapabilityLease("profile-owner");
    const legacyListener = {
      ...endpoint(1),
      health: { path: "/healthz" },
      timeouts: { headers: 15_000, request: 30_000, socket: 30_000 },
    };
    withPluginHttpRouteRegistry(registry, () => register({ legacyListener }), lease);
    const removeSibling = register({
      path: "/sibling",
      legacyListener: structuredClone(legacyListener),
      throwOnFailure: true,
    });
    await listening();
    const server = httpServers[1]!;
    expect(server).toMatchObject(restrictedTimeouts);
    expect(registry.httpRoutes).toHaveLength(2);
    for (const path of ["/webhook", "/sibling"]) {
      await expectReply(send(1, path));
    }
    expect((await send(1, "/healthz")).headers["content-type"]).toBeUndefined();

    const log = vi.fn();
    for (const conflict of [
      { ...legacyListener, health: { path: "/healthz", contentType: "text/plain" } },
      { ...legacyListener, health: undefined },
      { ...legacyListener, timeouts: undefined },
    ]) {
      expect(() =>
        register({ path: "/conflicting", legacyListener: conflict, log, throwOnFailure: true }),
      ).toThrow("conflicting legacy webhook health or timeout profile");
    }
    register({ path: "/conflicting", log });
    expect(log).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining("registrations sharing a port must use the same profile"),
    );
    await listening();
    expect(registry.httpRoutes).toHaveLength(2);
    await expectProfile(server);

    const handoff = park(lease);
    removeSibling();
    await listening();
    await expectReply(send(1), { status: 503 });
    const removeSuccessor = register({
      path: "/sibling",
      legacyListener: { ...endpoint(1), health: { path: "/healthz", contentType: "text/plain" } },
      throwOnFailure: true,
    });
    await listening();
    await expectProfile(server, "text/plain");
    await expectReply(send(1, "/sibling"));
    await expectReply(send(1), { status: 503 });
    removeSuccessor();
    await listening();
    await expectProfile(server);
    await expectReply(send(1), { status: 503 });
    await retire(server, handoff.release);
    expect(httpServers).toEqual([gatewayServer]);
  });

  it("delivers absolute-form callback targets unchanged to their legacy handler", async () => {
    const path = "http://callbacks.example/webhook?tenant=one";
    register({ path });
    await listening();
    await expectReply(send(1, path, { method: "POST" }));
    for (const rejected of ["/webhook?tenant=one", "http://["]) {
      await expectReply(send(1, rejected, { method: "POST" }), { status: 404, body: "" });
    }
  });

  it("preserves legacy socket closure for an escaped handler failure and Gateway error responses", async () => {
    register({
      handler: () => {
        throw new Error("synthetic callback failure");
      },
    });
    await listening();
    await expect(send(1, "/webhook")).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(await send(0, "/webhook")).toMatchObject({
      status: 500,
      body: "Internal Server Error",
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  });

  it("preserves raw bytes, peer identity, runtime scope, and Gateway admission without exposing other endpoints", async () => {
    const body = '{ "event": "synthetic", "spacing":  true }';
    register({
      handler: verifiedCallback(async (req, res) => {
        expect(await readRequestBodyWithLimit(req, { maxBytes: 1024, timeoutMs: 1000 })).toBe(body);
        const legacyListener = getWebhookLegacyListener(req);
        expect({
          peer: req.socket.remoteAddress,
          plugin: getPluginRuntimeGatewayRequestScope()?.pluginId,
          legacyListener: legacyListener ?? null,
        }).toEqual({
          peer: "127.0.0.1",
          plugin: "demo",
          legacyListener: req.socket.localPort === claim.port ? null : endpoint(1),
        });
        if (legacyListener) {
          expect(Reflect.set(legacyListener, "port", claim.port + 2)).toBe(false);
        }
        res.end("accepted");
      }),
    });
    register({ path: "/healthz", handler: () => false });
    register(
      {
        path: "/other",
        handler: (_req, res) => {
          res.end("other");
        },
      },
      0,
    );
    await listening();
    const signedBody = { method: "POST", body, headers: signedHeaders };
    for (const offset of [0, 1]) {
      await expectReply(
        send(offset, "/webhook", {
          ...signedBody,
          headers: {
            ...signedHeaders,
            "x-openclaw-legacy-listener": JSON.stringify(endpoint(2)),
          },
        }),
      );
      expect((await send(offset, "/webhook", { method: "POST", body })).status).toBe(401);
    }
    expect((await send(0, "/other")).status).toBe(200);
    for (const path of ["/other", "/healthz", "/tools/invoke", "/"]) {
      expect((await send(1, path)).status, path).toBe(404);
    }
    expect(tryBeginGatewaySuspendAdmission(() => {})?.commit()).toBe(true);
    await expectReply(send(1, "/webhook", signedBody), { status: 503 });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["protected namespace", "/api/channels/telegram", 401, 403, undefined],
    [
      "capability rewrite",
      "/__openclaw__/cap/vendor/webhook",
      200,
      200,
      "rewritten sibling: /webhook?oc_cap=vendor",
    ],
    ["incomplete capability", "/__openclaw__/cap/vendor", 401, 401, undefined],
  ] as const)(
    "preserves %s on the legacy port and the primary listener's policy",
    async (_name, path, primaryStatus, forwardedPrimaryStatus, primaryBody) => {
      expect(() => register({ auth: "gateway", throwOnFailure: true })).toThrow(
        "legacy webhook listeners require plugin authentication",
      );
      expect(registry.httpRoutes).toHaveLength(0);
      register({
        path,
        handler: verifiedCallback((_req, res) => {
          expect(getPluginRuntimeGatewayRequestScope()?.client?.connect.scopes).toEqual([]);
          res.end("vendor accepted");
        }, path),
      });
      register({
        handler: (req, res) => {
          res.end(`rewritten sibling: ${req.url}`);
        },
      });
      const gatewayOnlyHandler = vi.fn();
      registry.httpRoutes.push({
        path,
        auth: "gateway",
        match: "exact",
        legacyListeners: [endpoint(1)],
        handler: gatewayOnlyHandler,
      });
      await listening();
      for (const forwarded of [false, true]) {
        const headers = forwarded ? forwardedHeaders : {};
        const signed = { ...headers, ...signedHeaders };
        const options = { method: "POST", headers: signed };
        await expectReply(send(1, path, options), { status: 200, body: "vendor accepted" });
        const wrongSecret = { ...headers, "x-webhook-secret": "wrong" };
        await expectReply(send(1, path, { method: "POST", headers: wrongSecret }), { status: 401 });
        const primary = await send(0, path, { method: "POST", headers: signed });
        expect(primary.status).toBe(forwarded ? forwardedPrimaryStatus : primaryStatus);
        if (forwarded && forwardedPrimaryStatus === 403) {
          expect(primary.body).toContain("proxy_attribution_required");
        }
        if (primaryBody !== undefined) {
          expect(primary.body).toBe(primaryBody);
        }
        await expectReply(send(1, "/tools/invoke", options), { status: 404 });
      }
      expect(gatewayOnlyHandler).not.toHaveBeenCalled();
    },
  );

  it("retains only the restarting account's port across route handoff and registry replacement", async () => {
    let handled = 0;
    const replyWithPort = (req: IncomingMessage, res: ServerResponse) => {
      res.end(String(getWebhookLegacyListener(req)?.port));
    };
    const lease = createPluginRuntimeCapabilityLease("old-account");
    const first = withPluginHttpRouteRegistry(
      registry,
      () =>
        register({
          handler: (req, res) => {
            handled += 1;
            replyWithPort(req, res);
          },
        }),
      lease,
    );
    const second = register({ handler: replyWithPort }, 2);
    await listening();
    for (const offset of [1, 2]) {
      expect((await send(offset)).body).toBe(String(claim.port + offset));
    }
    const originalListeners = httpServers.slice(1);
    const handoff = park(lease);
    const expectParkedEndpoint = async () => {
      const before = handled;
      await expectReply(send(1), {
        status: 503,
        headers: { "retry-after": "1" },
        body: "plugin route is restarting; retry",
      });
      expect(handled).toBe(before);
    };
    await expectParkedEndpoint();
    expect((await send(2)).body).toBe(String(claim.port + 2));
    const revived = register({ handler: replyWithPort });
    expect((await send(1)).body).toBe(String(claim.port + 1));
    revived();
    await expectParkedEndpoint();
    await retire(originalListeners[1]!, second);
    expect((await send(1)).status).toBe(503);
    expect(httpServers.slice(1)).toEqual([originalListeners[0]]);
    const next = createEmptyPluginRegistry();
    adoptPluginHttpRouteHandoffs(registry, next);
    registry = next;
    const successor = register({
      handler: (_req, res) => {
        register({ path: "/registered-by-request", throwOnFailure: true }, 0);
        res.end("replacement");
      },
    });
    first();
    expect((await send(1)).body).toBe("replacement");
    expect(httpServers.slice(1)).toEqual([originalListeners[0]]);
    handoff.release();
    expect(httpServers.slice(1)).toEqual([originalListeners[0]]);
    expect((await send(1)).body).toBe("replacement");
    await retire(originalListeners[0]!, successor);
    expect(httpServers).toEqual([gatewayServer]);
  });

  it("reports an occupied port and retries on a route change after it is freed", async () => {
    const blocker = createServer();
    // A wildcard bind can coexist with the loopback listener on macOS.
    blocker.listen(endpoint(1));
    await once(blocker, "listening");
    try {
      const removeTrigger = register({ path: "/route-change-trigger" }, 0);
      register();
      await Promise.resolve();
      const listener = httpServers[1]!;
      await once(listener, "error");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`Legacy webhook listener 127.0.0.1:${claim.port + 1} failed`),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "update the external callback or reverse proxy to the Gateway port",
        ),
      );
      await expectReply(send(0));

      await close(blocker);
      removeTrigger();
      await listening();
      await expectReply(send(1));
    } finally {
      blocker.closeAllConnections();
      await close(blocker);
    }
  });

  it("drains retired listeners until callbacks finish and closes pending retired sockets on owner stop", async () => {
    const callbacks = [1, 2].map((offset) => {
      const entered = createDeferred();
      const release = createDeferred();
      const finished = createDeferred();
      const unregister = register({
        path: `/callback-${offset}`,
        legacyListener: { ...endpoint(offset), health: { path: "/healthz" } },
        handler: async (_req, res) => {
          entered.resolve();
          try {
            await release.promise;
            res.end("accepted");
          } finally {
            finished.resolve();
          }
        },
      });
      return { offset, entered, release, finished, unregister };
    });
    await listening();
    const servers = httpServers.slice(1);
    const closed = servers.map((server) => once(server, "close"));
    const responses = callbacks.map(({ offset }) =>
      send(offset, `/callback-${offset}`).then(
        (response) => ({ response }),
        (error: unknown) => ({ error }),
      ),
    );
    try {
      await Promise.all(callbacks.map(({ entered }) => entered.promise));
      for (const { offset } of callbacks) {
        // A prior keep-alive response must not supply the retired-port probe's socket.
        expect(
          await send(offset, "/healthz", { headers: { Connection: "keep-alive" } }),
        ).toMatchObject({ status: 200, body: "ok" });
      }
      for (const { unregister } of callbacks) {
        unregister();
      }
      await Promise.resolve();
      expect(servers.map((server) => server.listening)).toEqual([false, false]);
      expect(httpServers.slice(1)).toEqual(servers);
      const retiredRequests = vi.fn();
      for (const server of servers) {
        server.on("request", retiredRequests);
      }
      for (const { offset } of callbacks) {
        // A refused connect or a reset both close the probe; neither may dispatch a callback.
        await expect(send(offset, `/callback-${offset}`)).rejects.toMatchObject({
          code: expect.stringMatching(/^ECONN(?:REFUSED|RESET)$/),
        });
      }
      expect(retiredRequests).not.toHaveBeenCalled();

      callbacks[0]!.release.resolve();
      expect(await responses[0]).toMatchObject({ response: { status: 200, body: "accepted" } });
      await closed[0];
      expect(httpServers).toEqual([gatewayServer, servers[1]]);

      stop();
      expect(await responses[1]).toMatchObject({ error: { code: "ECONNRESET" } });
      await closed[1];
      expect(httpServers).toEqual([gatewayServer]);
      expect(retiredRequests).not.toHaveBeenCalled();
    } finally {
      for (const { release, unregister } of callbacks) {
        release.resolve();
        unregister();
      }
      stop();
      await Promise.all(closed);
      await Promise.all(callbacks.map(({ finished }) => finished.promise));
      await Promise.all(responses);
      stop = start();
    }
  });
});
