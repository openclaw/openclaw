import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { makeMockHttpResponse } from "../test-http-response.js";
import { createTestRegistry } from "./__tests__/test-utils.js";
import {
  createGatewayPluginRequestHandler,
  isRegisteredPluginHttpRoutePath,
  shouldBypassControlUiSpaForPluginPath,
  shouldEnforceGatewayAuthForPluginPath,
} from "./plugins-http.js";

type PluginHandlerLog = Parameters<typeof createGatewayPluginRequestHandler>[0]["log"];

function createPluginLog(): PluginHandlerLog {
  return { warn: vi.fn() } as unknown as PluginHandlerLog;
}

function createRoute(params: {
  path: string;
  pluginId?: string;
  kind?: "default" | "webhook";
  handler?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}) {
  return {
    pluginId: params.pluginId ?? "route",
    path: params.path,
    handler: params.handler ?? (() => {}),
    kind: params.kind ?? "default",
    source: params.pluginId ?? "route",
  };
}

describe("createGatewayPluginRequestHandler", () => {
  it("returns false when no handlers are registered", async () => {
    const log = createPluginLog();
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry(),
      log,
    });
    const { res } = makeMockHttpResponse();
    const handled = await handler({} as IncomingMessage, res);
    expect(handled).toBe(false);
  });

  it("continues until a handler reports it handled the request", async () => {
    const first = vi.fn(async () => false);
    const second = vi.fn(async () => true);
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpHandlers: [
          { pluginId: "first", handler: first, source: "first" },
          { pluginId: "second", handler: second, source: "second" },
        ],
      }),
      log: createPluginLog(),
    });

    const { res } = makeMockHttpResponse();
    const handled = await handler({} as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("handles registered http routes before generic handlers", async () => {
    const routeHandler = vi.fn(async (_req, res: ServerResponse) => {
      res.statusCode = 200;
    });
    const fallback = vi.fn(async () => true);
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [createRoute({ path: "/demo", handler: routeHandler })],
        httpHandlers: [{ pluginId: "fallback", handler: fallback, source: "fallback" }],
      }),
      log: createPluginLog(),
    });

    const { res } = makeMockHttpResponse();
    const handled = await handler({ url: "/demo" } as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(routeHandler).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("matches canonicalized route variants before generic handlers", async () => {
    const routeHandler = vi.fn(async (_req, res: ServerResponse) => {
      res.statusCode = 200;
    });
    const fallback = vi.fn(async () => true);
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [createRoute({ path: "/api/demo", handler: routeHandler })],
        httpHandlers: [{ pluginId: "fallback", handler: fallback, source: "fallback" }],
      }),
      log: createPluginLog(),
    });

    const { res } = makeMockHttpResponse();
    const handled = await handler({ url: "/API//demo" } as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(routeHandler).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("logs and responds with 500 when a handler throws", async () => {
    const log = createPluginLog();
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpHandlers: [
          {
            pluginId: "boom",
            handler: async () => {
              throw new Error("boom");
            },
            source: "boom",
          },
        ],
      }),
      log,
    });

    const { res, setHeader, end } = makeMockHttpResponse();
    const handled = await handler({} as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(res.statusCode).toBe(500);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
    expect(end).toHaveBeenCalledWith("Internal Server Error");
  });
});

describe("plugin HTTP registry helpers", () => {
  it("detects registered route paths", () => {
    const registry = createTestRegistry({
      httpRoutes: [createRoute({ path: "/demo" })],
    });
    expect(isRegisteredPluginHttpRoutePath(registry, "/demo")).toBe(true);
    expect(isRegisteredPluginHttpRoutePath(registry, "/missing")).toBe(false);
  });

  it("matches canonicalized variants of registered route paths", () => {
    const registry = createTestRegistry({
      httpRoutes: [createRoute({ path: "/api/demo" })],
    });
    expect(isRegisteredPluginHttpRoutePath(registry, "/api//demo")).toBe(true);
    expect(isRegisteredPluginHttpRoutePath(registry, "/API/demo")).toBe(true);
    expect(isRegisteredPluginHttpRoutePath(registry, "/api/%2564emo")).toBe(true);
  });

  it("enforces auth for protected and default exact plugin routes, but not webhook exact routes", () => {
    const registry = createTestRegistry({
      httpRoutes: [
        createRoute({ path: "/demo" }),
        createRoute({ path: "/bluebubbles-webhook", kind: "webhook" }),
      ],
    });
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/demo")).toBe(true);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/bluebubbles-webhook")).toBe(false);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/api/channels/status")).toBe(true);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/not-plugin")).toBe(false);
  });

  it("only bypasses control ui for exact webhook-kind routes on non-core paths", () => {
    const registry = createTestRegistry({
      httpRoutes: [
        {
          pluginId: "bluebubbles",
          path: "/bluebubbles-webhook",
          handler: () => {},
          kind: "webhook",
          source: "bluebubbles",
        },
        {
          pluginId: "route",
          path: "/chat",
          handler: () => {},
          kind: "default",
          source: "route",
        },
        {
          pluginId: "route",
          path: "/plugins/demo",
          handler: () => {},
          kind: "webhook",
          source: "route",
        },
      ],
    });

    expect(shouldBypassControlUiSpaForPluginPath(registry, "/bluebubbles-webhook")).toBe(true);
    expect(shouldBypassControlUiSpaForPluginPath(registry, "/chat")).toBe(false);
    expect(shouldBypassControlUiSpaForPluginPath(registry, "/plugins/demo")).toBe(false);
    expect(shouldBypassControlUiSpaForPluginPath(registry, "/missing")).toBe(false);
  });

  it("does not canonicalize webhook-kind route matching", () => {
    const registry = createTestRegistry({
      httpRoutes: [
        {
          pluginId: "bluebubbles",
          path: "/bluebubbles-webhook",
          handler: () => {},
          kind: "webhook",
          source: "bluebubbles",
        },
      ],
    });

    expect(isRegisteredPluginHttpRoutePath(registry, "/bluebubbles-webhook")).toBe(true);
    expect(isRegisteredPluginHttpRoutePath(registry, "/BLUEBUBBLES-WEBHOOK")).toBe(false);
    expect(isRegisteredPluginHttpRoutePath(registry, "/bluebubbles-webhook/")).toBe(true);
    expect(isRegisteredPluginHttpRoutePath(registry, "/bluebubbles%2Dwebhook")).toBe(false);
  });
});
