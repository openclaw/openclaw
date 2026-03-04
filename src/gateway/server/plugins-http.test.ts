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
  auth?: "gateway" | "plugin";
  match?: "exact" | "prefix";
  handler?: (req: IncomingMessage, res: ServerResponse) => boolean | void | Promise<boolean | void>;
}) {
  return {
    pluginId: params.pluginId ?? "route",
    path: params.path,
    auth: params.auth ?? "gateway",
    match: params.match ?? "exact",
    handler: params.handler ?? (() => {}),
    source: params.pluginId ?? "route",
  };
}

function buildRepeatedEncodedSlash(depth: number): string {
  let encodedSlash = "%2f";
  for (let i = 1; i < depth; i++) {
    encodedSlash = encodedSlash.replace(/%/g, "%25");
  }
  return encodedSlash;
}

describe("createGatewayPluginRequestHandler", () => {
  it("returns false when no routes are registered", async () => {
    const log = createPluginLog();
    const registry = createTestRegistry();
    const handler = createGatewayPluginRequestHandler({
      getRegistry: () => registry,
      log,
    });
    const { res } = makeMockHttpResponse();
    const handled = await handler({} as IncomingMessage, res);
    expect(handled).toBe(false);
  });

  it("handles exact route matches", async () => {
    const routeHandler = vi.fn(async (_req, res: ServerResponse) => {
      res.statusCode = 200;
    });
    const registry = createTestRegistry({
      httpRoutes: [createRoute({ path: "/demo", handler: routeHandler })],
    });
    const handler = createGatewayPluginRequestHandler({
      getRegistry: () => registry,
      log: createPluginLog(),
    });

    const { res } = makeMockHttpResponse();
    const handled = await handler({ url: "/demo" } as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(routeHandler).toHaveBeenCalledTimes(1);
  });

  it("prefers exact matches before prefix matches", async () => {
    const exactHandler = vi.fn(async (_req, res: ServerResponse) => {
      res.statusCode = 200;
    });
    const prefixHandler = vi.fn(async () => true);
    const registry = createTestRegistry({
      httpRoutes: [
        createRoute({ path: "/api", match: "prefix", handler: prefixHandler }),
        createRoute({ path: "/api/demo", match: "exact", handler: exactHandler }),
      ],
    });
    const handler = createGatewayPluginRequestHandler({
      getRegistry: () => registry,
      log: createPluginLog(),
    });

    const { res } = makeMockHttpResponse();
    const handled = await handler({ url: "/api/demo" } as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(exactHandler).toHaveBeenCalledTimes(1);
    expect(prefixHandler).not.toHaveBeenCalled();
  });

  it("supports route fallthrough when handler returns false", async () => {
    const first = vi.fn(async () => false);
    const second = vi.fn(async () => true);
    const registry = createTestRegistry({
      httpRoutes: [
        createRoute({ path: "/hook", match: "exact", handler: first }),
        createRoute({ path: "/hook", match: "prefix", handler: second }),
      ],
    });
    const handler = createGatewayPluginRequestHandler({
      getRegistry: () => registry,
      log: createPluginLog(),
    });

    const { res } = makeMockHttpResponse();
    const handled = await handler({ url: "/hook" } as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("matches canonicalized route variants", async () => {
    const routeHandler = vi.fn(async (_req, res: ServerResponse) => {
      res.statusCode = 200;
    });
    const registry = createTestRegistry({
      httpRoutes: [createRoute({ path: "/api/demo", handler: routeHandler })],
    });
    const handler = createGatewayPluginRequestHandler({
      getRegistry: () => registry,
      log: createPluginLog(),
    });

    const { res } = makeMockHttpResponse();
    const handled = await handler({ url: "/API//demo" } as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(routeHandler).toHaveBeenCalledTimes(1);
  });

  it("picks up routes registered on a replacement registry (stale-registry regression)", async () => {
    // Simulate what happens when loadOpenClawPlugins creates a new registry
    // after a plugin config change: the handler must use the NEW active registry
    // so that routes re-registered by channels (e.g. /line/webhook) are found.
    let activeRegistry = createTestRegistry();

    const handler = createGatewayPluginRequestHandler({
      getRegistry: () => activeRegistry,
      log: createPluginLog(),
    });

    // First registry — route not yet registered.
    const { res: res1 } = makeMockHttpResponse();
    expect(await handler({ url: "/line/webhook" } as IncomingMessage, res1)).toBe(false);

    // Swap in a new registry (simulates setActivePluginRegistry after plugin config change).
    const webhookHandler = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
    });
    activeRegistry = createTestRegistry({
      httpRoutes: [createRoute({ path: "/line/webhook", auth: "plugin", handler: webhookHandler })],
    });

    // Handler must now resolve the route without any gateway restart.
    const { res: res2 } = makeMockHttpResponse();
    expect(await handler({ url: "/line/webhook" } as IncomingMessage, res2)).toBe(true);
    expect(webhookHandler).toHaveBeenCalledTimes(1);
  });

  it("logs and responds with 500 when a route throws", async () => {
    const log = createPluginLog();
    const registry = createTestRegistry({
      httpRoutes: [
        createRoute({
          path: "/boom",
          handler: async () => {
            throw new Error("boom");
          },
        }),
      ],
    });
    const handler = createGatewayPluginRequestHandler({
      getRegistry: () => registry,
      log,
    });

    const { res, setHeader, end } = makeMockHttpResponse();
    const handled = await handler({ url: "/boom" } as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(res.statusCode).toBe(500);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
    expect(end).toHaveBeenCalledWith("Internal Server Error");
  });
});

describe("plugin HTTP route auth checks", () => {
  const deeplyEncodedChannelPath =
    "/api%2525252fchannels%2525252fnostr%2525252fdefault%2525252fprofile";
  const decodeOverflowPublicPath = `/googlechat${buildRepeatedEncodedSlash(40)}public`;

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

  it("enforces auth for protected and gateway-auth routes", () => {
    const registry = createTestRegistry({
      httpRoutes: [
        createRoute({ path: "/googlechat", match: "prefix", auth: "plugin" }),
        createRoute({ path: "/api/demo", auth: "gateway" }),
      ],
    });
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/api//demo")).toBe(true);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/googlechat/public")).toBe(false);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/api/channels/status")).toBe(true);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, deeplyEncodedChannelPath)).toBe(true);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, decodeOverflowPublicPath)).toBe(true);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/not-plugin")).toBe(false);
  });
});
