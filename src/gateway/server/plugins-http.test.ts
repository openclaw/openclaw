import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { makeMockHttpResponse } from "../test-http-response.js";
import { createTestRegistry } from "./__tests__/test-utils.js";
import {
  createGatewayPluginRequestHandler,
  isRegisteredPluginHttpRoutePath,
  shouldEnforceGatewayAuthForPluginPath,
} from "./plugins-http.js";

type PluginHandlerLog = Parameters<typeof createGatewayPluginRequestHandler>[0]["log"];

function createPluginLog(): PluginHandlerLog {
  return { warn: vi.fn() } as unknown as PluginHandlerLog;
}

function createRoute(params: {
  path: string;
  pluginId?: string;
  handler?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}) {
  return {
    pluginId: params.pluginId ?? "route",
    path: params.path,
    handler: params.handler ?? (() => {}),
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

  it("enforces auth for protected and registered plugin routes", () => {
    const registry = createTestRegistry({
      httpRoutes: [createRoute({ path: "/api/demo" })],
    });
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/api//demo")).toBe(true);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/api/channels/status")).toBe(true);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/not-plugin")).toBe(false);
  });
});
