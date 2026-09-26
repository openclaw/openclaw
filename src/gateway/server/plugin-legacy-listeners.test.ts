import { once } from "node:events";
import {
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
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
  const url = (offset: number, path = "/webhook") =>
    `http://127.0.0.1:${claim.port + offset}${path}`;
  const endpoint = (offset: number) => ({ port: claim.port + offset, host: "127.0.0.1" });

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
    stop = startPluginLegacyListeners({
      gatewayServer,
      httpServers,
      getRegistry: () => registry,
      warn,
    });
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
    await new Promise<void>((resolve) => {
      gatewayServer.close(() => resolve());
    });
    await claim.release();
  });

  const register = (params: Partial<Parameters<typeof registerPluginHttpRoute>[0]> = {}) => {
    const unregister = registerPluginHttpRoute({
      registry,
      path: "/webhook",
      pluginId: "demo",
      source: "webhook",
      auth: "plugin",
      reuseExistingSameOwner: true,
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

  const send = (
    offset: number,
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) =>
    new Promise<{
      status: number | undefined;
      headers: IncomingHttpHeaders;
      body: string;
      continues: number;
    }>((resolve, reject) => {
      let continues = 0;
      const req = request(
        {
          host: "127.0.0.1",
          port: claim.port + offset,
          path,
          method: options.method ?? "GET",
          headers: { Connection: "close", ...options.headers },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("error", reject);
          res.on("end", () => {
            req.destroy();
            resolve({ status: res.statusCode, headers: res.headers, body, continues });
          });
        },
      );
      req.on("error", reject);
      req.on("continue", () => {
        continues += 1;
        req.end(options.body);
      });
      if (options.headers?.Expect) {
        req.flushHeaders();
      } else {
        req.end(options.body);
      }
    });

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
      register({ path: "/no-health", legacyListener: endpoint(2) });
      await listening();

      for (const method of ["GET", "HEAD", "OPTIONS", "POST"]) {
        const response = await send(1, "/healthz", { method });
        expect(response.status).toBe(200);
        expect(response.body).toBe(method === "HEAD" ? "" : "ok");
        expect(response.headers).toEqual({
          date: expect.any(String),
          connection: "close",
          ...(contentType ? { "content-type": contentType } : {}),
          ...(method === "HEAD" ? {} : { "transfer-encoding": "chunked" }),
        });
      }
      expect(handler).not.toHaveBeenCalled();
      for (const path of ["/healthz?probe=1", "/healthz/", "/HEALTHZ", "/%68ealthz"]) {
        const response = await send(1, path);
        expect(response.status, path).toBe(404);
        expect(response.body, path).toBe("");
        expect(response.headers["content-type"], path).toBeUndefined();
      }
      expect(handler).toHaveBeenCalledTimes(4);
      expect(await send(2, "/healthz")).toMatchObject({ status: 404, body: "" });

      const gateway = await send(0, "/healthz");
      expect(gateway.status).toBe(200);
      expect(JSON.parse(gateway.body)).toEqual({ ok: true, status: "live" });
      expect(gateway.headers).toMatchObject({
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      expect(await send(0, "/healthz", { method: "OPTIONS" })).toMatchObject({
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
      legacyListener: {
        ...endpoint(1),
        health: { path: "/healthz" },
        timeouts: { headers: 15_000, request: 30_000, socket: 30_000 },
      },
      throwOnFailure: true,
    });
    await listening();
    const server = httpServers[1]!;
    expect(server).toMatchObject({
      headersTimeout: 15_000,
      requestTimeout: 30_000,
      timeout: 30_000,
    });
    expect(registry.httpRoutes).toHaveLength(2);
    for (const path of ["/webhook", "/sibling"]) {
      expect(await send(1, path)).toMatchObject({ status: 200, body: "accepted" });
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
    register({ path: "/conflicting", legacyListener: endpoint(1), log });
    expect(log).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining("registrations sharing a port must use the same profile"),
    );
    await listening();
    expect(registry.httpRoutes).toHaveLength(2);
    expect(httpServers.slice(1)).toEqual([server]);
    expect(server).toMatchObject({
      headersTimeout: 15_000,
      requestTimeout: 30_000,
      timeout: 30_000,
    });
    expect(await send(1, "/healthz")).toMatchObject({ status: 200, body: "ok" });
    expect((await send(1, "/healthz")).headers["content-type"]).toBeUndefined();

    const handoff = createPluginHttpRouteHandoff();
    cleanups.push(handoff.release);
    handoff.park(lease);
    lease.revoke();
    removeSibling();
    await listening();
    expect(await send(1, "/webhook")).toMatchObject({ status: 503 });
    const removeSuccessor = register({
      path: "/sibling",
      legacyListener: { ...endpoint(1), health: { path: "/healthz", contentType: "text/plain" } },
      throwOnFailure: true,
    });
    await listening();
    expect(httpServers.slice(1)).toEqual([server]);
    expect(server).toMatchObject({
      headersTimeout: 60_000,
      requestTimeout: 300_000,
      timeout: 0,
      keepAliveTimeout: 5_000,
    });
    expect((await send(1, "/healthz")).headers["content-type"]).toBe("text/plain");
    expect(await send(1, "/sibling")).toMatchObject({ status: 200, body: "accepted" });
    expect(await send(1, "/webhook")).toMatchObject({ status: 503 });
    removeSuccessor();
    await listening();
    expect(httpServers.slice(1)).toEqual([server]);
    expect(server).toMatchObject({
      headersTimeout: 15_000,
      requestTimeout: 30_000,
      timeout: 30_000,
    });
    expect(await send(1, "/healthz")).toMatchObject({ status: 200, body: "ok" });
    expect((await send(1, "/healthz")).headers["content-type"]).toBeUndefined();
    expect(await send(1, "/webhook")).toMatchObject({ status: 503 });
    const closed = once(server, "close");
    handoff.release();
    await closed;
    expect(httpServers).toEqual([gatewayServer]);
  });

  it("delivers absolute-form callback targets unchanged to their legacy handler", async () => {
    const path = "http://callbacks.example/webhook?tenant=one";
    register({
      path,
      legacyListener: endpoint(1),
      handler: (req, res) => {
        if (req.url !== path) {
          res.writeHead(404).end();
          return;
        }
        res.end("accepted");
      },
    });
    await listening();
    expect(await send(1, path, { method: "POST" })).toMatchObject({
      status: 200,
      body: "accepted",
    });
    expect(await send(1, "/webhook?tenant=one", { method: "POST" })).toMatchObject({
      status: 404,
      body: "",
    });
    expect(await send(1, "http://[", { method: "POST" })).toMatchObject({ status: 404, body: "" });
  });

  it("preserves legacy socket closure for an escaped handler failure and Gateway error responses", async () => {
    register({
      legacyListener: endpoint(1),
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
      legacyListener: endpoint(1),
      handler: async (req, res) => {
        if (req.url !== "/webhook") {
          res.writeHead(404).end();
          return;
        }
        if (req.headers["x-webhook-secret"] !== "synthetic-secret") {
          res.writeHead(401).end();
          return;
        }
        expect(await readRequestBodyWithLimit(req, { maxBytes: 1024, timeoutMs: 1000 })).toBe(body);
        res.setHeader("x-peer", req.socket.remoteAddress ?? "missing");
        const legacyListener = getWebhookLegacyListener(req);
        if (legacyListener) {
          expect(Reflect.set(legacyListener, "port", claim.port + 2)).toBe(false);
        }
        res.setHeader("x-legacy-listener", JSON.stringify(legacyListener ?? null));
        res.setHeader(
          "x-runtime-plugin",
          getPluginRuntimeGatewayRequestScope()?.pluginId ?? "missing",
        );
        res.end("accepted");
      },
    });
    register({ path: "/healthz", legacyListener: endpoint(1), handler: () => false });
    register({
      path: "/other",
      handler: (_req, res) => {
        res.end("other");
      },
    });
    await listening();
    for (const offset of [0, 1]) {
      const accepted = await fetch(url(offset), {
        method: "POST",
        body,
        headers: {
          "x-webhook-secret": "synthetic-secret",
          "x-openclaw-legacy-listener": JSON.stringify(endpoint(2)),
        },
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.text()).toBe("accepted");
      expect(accepted.headers.get("x-peer")).toBe("127.0.0.1");
      expect(JSON.parse(accepted.headers.get("x-legacy-listener")!)).toEqual(
        offset === 0 ? null : endpoint(1),
      );
      expect(accepted.headers.get("x-runtime-plugin")).toBe("demo");
      expect((await fetch(url(offset), { method: "POST", body })).status).toBe(401);
    }
    expect((await fetch(url(0, "/other"))).status).toBe(200);
    for (const path of ["/other", "/healthz", "/tools/invoke", "/"]) {
      expect((await fetch(url(1, path))).status, path).toBe(404);
    }
    expect(tryBeginGatewaySuspendAdmission(() => {})?.commit()).toBe(true);
    expect(
      (
        await fetch(url(1), {
          method: "POST",
          body,
          headers: { "x-webhook-secret": "synthetic-secret" },
        })
      ).status,
    ).toBe(503);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "protected namespace",
      path: "/api/channels/telegram",
      primaryStatus: 401,
      forwardedPrimaryStatus: 403,
      primaryBody: undefined,
    },
    {
      name: "capability rewrite",
      path: "/__openclaw__/cap/vendor/webhook",
      primaryStatus: 200,
      forwardedPrimaryStatus: 200,
      primaryBody: "rewritten sibling: /webhook?oc_cap=vendor",
    },
    {
      name: "incomplete capability",
      path: "/__openclaw__/cap/vendor",
      primaryStatus: 401,
      forwardedPrimaryStatus: 401,
      primaryBody: undefined,
    },
  ])(
    "preserves the $name callback on its legacy port and the primary listener's policy",
    async ({ path, primaryStatus, forwardedPrimaryStatus, primaryBody }) => {
      expect(() =>
        register({ auth: "gateway", legacyListener: endpoint(1), throwOnFailure: true }),
      ).toThrow("legacy webhook listeners require plugin authentication");
      expect(registry.httpRoutes).toHaveLength(0);
      register({
        path,
        legacyListener: endpoint(1),
        handler: (req, res) => {
          if (req.url !== path) {
            res.writeHead(404).end();
            return;
          }
          if (req.headers["x-webhook-secret"] !== "synthetic-secret") {
            res.writeHead(401).end();
            return;
          }
          expect(getPluginRuntimeGatewayRequestScope()?.client?.connect.scopes).toEqual([]);
          res.end("vendor accepted");
        },
      });
      register({
        path: "/webhook",
        legacyListener: endpoint(1),
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
        const headers: Record<string, string> = forwarded
          ? {
              "x-forwarded-for": "203.0.113.20",
              "x-forwarded-proto": "https",
              "x-forwarded-host": "callbacks.example",
            }
          : {};
        const signed = { ...headers, "x-webhook-secret": "synthetic-secret" };
        const accepted = await fetch(url(1, path), { method: "POST", headers: signed });
        expect(accepted.status).toBe(200);
        expect(await accepted.text()).toBe("vendor accepted");
        expect(
          (
            await fetch(url(1, path), {
              method: "POST",
              headers: { ...headers, "x-webhook-secret": "wrong" },
            })
          ).status,
        ).toBe(401);
        const primary = await fetch(url(0, path), { method: "POST", headers: signed });
        expect(primary.status).toBe(forwarded ? forwardedPrimaryStatus : primaryStatus);
        const primaryText = await primary.text();
        if (forwarded && forwardedPrimaryStatus === 403) {
          expect(primaryText).toContain("proxy_attribution_required");
        }
        if (primaryBody !== undefined) {
          expect(primaryText).toBe(primaryBody);
        }
        expect(
          (await fetch(url(1, "/tools/invoke"), { method: "POST", headers: signed })).status,
        ).toBe(404);
      }
      expect(gatewayOnlyHandler).not.toHaveBeenCalled();
    },
  );

  it("retains only the restarting account's port across route handoff and registry replacement", async () => {
    let handled = 0;
    const lease = createPluginRuntimeCapabilityLease("old-account");
    const first = withPluginHttpRouteRegistry(
      registry,
      () =>
        register({
          legacyListener: endpoint(1),
          handler: (req, res) => {
            handled += 1;
            res.end(String(getWebhookLegacyListener(req)?.port));
          },
        }),
      lease,
    );
    const second = register({ legacyListener: endpoint(2) });
    await listening();
    for (const offset of [1, 2]) {
      expect(await (await fetch(url(offset))).text()).toBe(String(claim.port + offset));
    }
    const originalListeners = httpServers.slice(1);
    const handoff = createPluginHttpRouteHandoff();
    cleanups.push(handoff.release);
    handoff.park(lease);
    lease.revoke();
    const expectParkedEndpoint = async () => {
      const before = handled;
      const response = await fetch(url(1));
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await response.text()).toBe("plugin route is restarting; retry");
      expect(handled).toBe(before);
    };
    await expectParkedEndpoint();
    expect(await (await fetch(url(2))).text()).toBe(String(claim.port + 2));
    const revived = register({ legacyListener: endpoint(1) });
    expect(await (await fetch(url(1))).text()).toBe(String(claim.port + 1));
    revived();
    await expectParkedEndpoint();
    const oldPortClosed = once(originalListeners[1]!, "close");
    second();
    await oldPortClosed;
    expect((await fetch(url(1))).status).toBe(503);
    expect(httpServers.slice(1)).toEqual([originalListeners[0]]);
    const next = createEmptyPluginRegistry();
    adoptPluginHttpRouteHandoffs(registry, next);
    registry = next;
    const successor = register({
      legacyListener: endpoint(1),
      handler: (_req, res) => {
        register({ path: "/registered-by-request", throwOnFailure: true });
        res.end("replacement");
      },
    });
    first();
    expect(await (await fetch(url(1))).text()).toBe("replacement");
    expect(httpServers.slice(1)).toEqual([originalListeners[0]]);
    handoff.release();
    expect(httpServers.slice(1)).toEqual([originalListeners[0]]);
    expect(await (await fetch(url(1))).text()).toBe("replacement");
    const finalPortClosed = once(originalListeners[0]!, "close");
    successor();
    await finalPortClosed;
    expect(httpServers).toEqual([gatewayServer]);
  });

  it("preserves native expectations, ordinary Upgrade requests, and CONNECT closure", async () => {
    const body = "synthetic webhook body";
    const handler = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      expect(getWebhookLegacyListener(req)).toEqual(endpoint(1));
      expect(await readRequestBodyWithLimit(req, { maxBytes: 1024 })).toBe(body);
      res.end("accepted");
    });
    register({ legacyListener: { ...endpoint(1), health: { path: "/healthz" } }, handler });
    await listening();
    for (const path of ["/webhook", "/healthz"]) {
      expect(
        await send(1, path, {
          method: "POST",
          body,
          headers: { Expect: "100-continue", "Content-Length": String(Buffer.byteLength(body)) },
        }),
      ).toMatchObject({ status: 200, body: path === "/healthz" ? "ok" : "accepted", continues: 1 });
      const rejected = await send(1, path, {
        method: "POST",
        headers: { Expect: "unsupported-expectation" },
      });
      expect(rejected).toMatchObject({ status: 417, body: "", continues: 0 });
      expect(rejected.headers).toEqual({
        date: expect.any(String),
        connection: "close",
        "transfer-encoding": "chunked",
      });
      expect(
        await send(1, path, {
          method: "POST",
          body,
          headers: { Connection: "Upgrade", Upgrade: "websocket" },
        }),
      ).toMatchObject({ status: 200, body: path === "/healthz" ? "ok" : "accepted" });
    }
    await expect(send(1, "/healthz", { method: "CONNECT" })).rejects.toMatchObject({
      code: "ECONNRESET",
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("reports an occupied port and retries it after the conflicting route is removed", async () => {
    const removeBlocker = register({
      path: "/occupying-webhook",
      legacyListener: { port: claim.port + 1, host: "0.0.0.0" },
    });
    await listening();
    const blocker = httpServers[1]!;
    register({ legacyListener: endpoint(1) });
    await Promise.resolve();
    const listener = httpServers[2]!;
    await once(listener, "error");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`Legacy webhook listener 127.0.0.1:${claim.port + 1} failed`),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("update the external callback or reverse proxy to the Gateway port"),
    );
    expect(await (await fetch(url(0))).text()).toBe("accepted");

    const closed = once(blocker, "close");
    removeBlocker();
    await closed;
    expect(await (await fetch(url(1))).text()).toBe("accepted");
  });

  it("drains retired listeners until callbacks finish and closes pending retired sockets on owner stop", async () => {
    const callbacks = [1, 2].map((offset) => {
      const entered = createDeferred();
      const release = createDeferred();
      const finished = createDeferred();
      const unregister = register({
        path: `/callback-${offset}`,
        legacyListener: endpoint(offset),
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
      for (const { unregister } of callbacks) {
        unregister();
      }
      await Promise.resolve();
      expect(servers.map((server) => server.listening)).toEqual([false, false]);
      expect(httpServers.slice(1)).toEqual(servers);
      for (const { offset } of callbacks) {
        await expect(send(offset, `/callback-${offset}`)).rejects.toMatchObject({
          code: "ECONNREFUSED",
        });
      }

      callbacks[0]!.release.resolve();
      expect(await responses[0]).toMatchObject({ response: { status: 200, body: "accepted" } });
      await closed[0];
      expect(httpServers).toEqual([gatewayServer, servers[1]]);

      stop();
      expect(await responses[1]).toMatchObject({ error: { code: "ECONNRESET" } });
      await closed[1];
      expect(httpServers).toEqual([gatewayServer]);
    } finally {
      for (const { release, unregister } of callbacks) {
        release.resolve();
        unregister();
      }
      stop();
      await Promise.all(closed);
      await Promise.all(callbacks.map(({ finished }) => finished.promise));
      await Promise.all(responses);
      stop = startPluginLegacyListeners({
        gatewayServer,
        httpServers,
        getRegistry: () => registry,
        warn,
      });
    }
  });
});
