import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPluginHttpRoute } from "../../plugins/http-registry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  pinActivePluginHttpRouteRegistry,
  releasePinnedPluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "../server-methods/types.js";
import { makeMockHttpResponse } from "../test-http-response.js";
import { createTestRegistry } from "./__tests__/test-utils.js";
import {
  createGatewayPluginRequestHandler,
  isRegisteredPluginHttpRoutePath,
  shouldEnforceGatewayAuthForPluginPath,
} from "./plugins-http.js";

const loadOpenClawPlugins = vi.hoisted(() => vi.fn());
type HandleGatewayRequestOptions = GatewayRequestOptions & {
  extraHandlers?: Record<string, unknown>;
};
const handleGatewayRequest = vi.hoisted(() =>
  vi.fn(async (_opts: HandleGatewayRequestOptions) => {}),
);

vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins,
}));

vi.mock("../server-methods.js", () => ({
  handleGatewayRequest,
}));

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

function createSubagentRuntimeRegistry() {
  return createTestRegistry();
}

async function createSubagentRuntime(): Promise<PluginRuntime["subagent"]> {
  const serverPlugins = await import("../server-plugins.js");
  const serverPluginBootstrap = await import("../server-plugin-bootstrap.js");
  const runtimeModule = await import("../../plugins/runtime/index.js");
  loadOpenClawPlugins.mockReturnValue(createSubagentRuntimeRegistry());
  serverPluginBootstrap.loadGatewayStartupPlugins({
    cfg: {},
    workspaceDir: "/tmp",
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    coreGatewayHandlers: {},
    baseMethods: [],
  });
  serverPlugins.setFallbackGatewayContext({} as GatewayRequestContext);
  const call = loadOpenClawPlugins.mock.calls.at(-1)?.[0] as
    | { runtimeOptions?: { allowGatewaySubagentBinding?: boolean } }
    | undefined;
  if (call?.runtimeOptions?.allowGatewaySubagentBinding !== true) {
    throw new Error("Expected loadGatewayPlugins to opt into gateway subagent binding");
  }
  return runtimeModule.createPluginRuntime({ allowGatewaySubagentBinding: true }).subagent;
}

function createSecurePluginRouteHandler(params: {
  exactPluginHandler: () => boolean | Promise<boolean>;
  prefixGatewayHandler: () => boolean | Promise<boolean>;
}) {
  return createGatewayPluginRequestHandler({
    registry: createTestRegistry({
      httpRoutes: [
        createRoute({
          path: "/plugin/secure/report",
          match: "exact",
          auth: "plugin",
          handler: params.exactPluginHandler,
        }),
        createRoute({
          path: "/plugin/secure",
          match: "prefix",
          auth: "gateway",
          handler: params.prefixGatewayHandler,
        }),
      ],
    }),
    log: createPluginLog(),
  });
}

async function invokeSecureGatewayRoute(params: { gatewayAuthSatisfied: boolean }) {
  const exactPluginHandler = vi.fn(async () => false);
  const prefixGatewayHandler = vi.fn(async () => true);
  const handler = createSecurePluginRouteHandler({
    exactPluginHandler,
    prefixGatewayHandler,
  });
  const { res } = makeMockHttpResponse();
  const handled = await handler(
    { url: "/plugin/secure/report" } as IncomingMessage,
    res,
    undefined,
    { gatewayAuthSatisfied: params.gatewayAuthSatisfied },
  );
  return { handled, exactPluginHandler, prefixGatewayHandler };
}

function mockOperatorAdminScopeFailure() {
  loadOpenClawPlugins.mockReset();
  handleGatewayRequest.mockReset();
  handleGatewayRequest.mockImplementation(async (opts: HandleGatewayRequestOptions) => {
    const scopes = opts.client?.connect.scopes ?? [];
    if (opts.req.method === "sessions.delete" && !scopes.includes("operator.admin")) {
      opts.respond(false, undefined, {
        code: "invalid_request",
        message: "missing scope: operator.admin",
      });
      return;
    }
    opts.respond(true, {});
  });
}

async function invokeLeastPrivilegeDeleteRoute(params: {
  path: string;
  auth: "gateway" | "plugin";
  gatewayAuthSatisfied: boolean;
}) {
  mockOperatorAdminScopeFailure();

  const subagent = await createSubagentRuntime();
  const log = createPluginLog();
  const handler = createGatewayPluginRequestHandler({
    registry: createTestRegistry({
      httpRoutes: [
        createRoute({
          path: params.path,
          auth: params.auth,
          handler: async () => {
            await subagent.deleteSession({ sessionKey: "agent:main:subagent:child" });
            return true;
          },
        }),
      ],
    }),
    log,
  });

  const response = makeMockHttpResponse();
  const handled = await handler({ url: params.path } as IncomingMessage, response.res, undefined, {
    gatewayAuthSatisfied: params.gatewayAuthSatisfied,
  });
  return { handled, log, ...response };
}

function expectLeastPrivilegeDeleteRouteFailure(params: {
  handled: boolean;
  setHeader: ReturnType<typeof makeMockHttpResponse>["setHeader"];
  end: ReturnType<typeof makeMockHttpResponse>["end"];
  log: ReturnType<typeof createPluginLog>;
}) {
  expect(params.handled).toBe(true);
  expect(handleGatewayRequest).toHaveBeenCalledTimes(1);
  expect(handleGatewayRequest.mock.calls[0]?.[0]?.client?.connect.scopes).toEqual([
    "operator.write",
  ]);
  expect(params.setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
  expect(params.end).toHaveBeenCalledWith("Internal Server Error");
  expect(params.log.warn).toHaveBeenCalledWith(
    expect.stringContaining("missing scope: operator.admin"),
  );
}

describe("createGatewayPluginRequestHandler", () => {
  afterEach(() => {
    releasePinnedPluginHttpRouteRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("caps unauthenticated plugin routes to non-admin subagent scopes", async () => {
    const { handled, res, setHeader, end, log } = await invokeLeastPrivilegeDeleteRoute({
      path: "/hook",
      auth: "plugin",
      gatewayAuthSatisfied: false,
    });

    expect(res.statusCode).toBe(500);
    expectLeastPrivilegeDeleteRouteFailure({ handled, setHeader, end, log });
  });

  it("keeps gateway-authenticated plugin routes on least-privilege runtime scopes", async () => {
    const { handled, res, setHeader, end, log } = await invokeLeastPrivilegeDeleteRoute({
      path: "/secure-hook",
      auth: "gateway",
      gatewayAuthSatisfied: true,
    });

    expect(res.statusCode).toBe(500);
    expectLeastPrivilegeDeleteRouteFailure({ handled, setHeader, end, log });
  });

  it("returns false when no routes are registered", async () => {
    const log = createPluginLog();
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry(),
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
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [createRoute({ path: "/demo", handler: routeHandler })],
      }),
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
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          createRoute({ path: "/api", match: "prefix", handler: prefixHandler }),
          createRoute({ path: "/api/demo", match: "exact", handler: exactHandler }),
        ],
      }),
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
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          createRoute({ path: "/hook", match: "exact", handler: first }),
          createRoute({ path: "/hook", match: "prefix", handler: second }),
        ],
      }),
      log: createPluginLog(),
    });

    const { res } = makeMockHttpResponse();
    const handled = await handler({ url: "/hook" } as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a matched gateway route reaches dispatch without auth", async () => {
    const { handled, exactPluginHandler, prefixGatewayHandler } = await invokeSecureGatewayRoute({
      gatewayAuthSatisfied: false,
    });
    expect(handled).toBe(false);
    expect(exactPluginHandler).not.toHaveBeenCalled();
    expect(prefixGatewayHandler).not.toHaveBeenCalled();
  });

  it("allows gateway route fallthrough only after gateway auth succeeds", async () => {
    const { handled, exactPluginHandler, prefixGatewayHandler } = await invokeSecureGatewayRoute({
      gatewayAuthSatisfied: true,
    });
    expect(handled).toBe(true);
    expect(exactPluginHandler).toHaveBeenCalledTimes(1);
    expect(prefixGatewayHandler).toHaveBeenCalledTimes(1);
  });

  it("matches canonicalized route variants", async () => {
    const routeHandler = vi.fn(async (_req, res: ServerResponse) => {
      res.statusCode = 200;
    });
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [createRoute({ path: "/api/demo", handler: routeHandler })],
      }),
      log: createPluginLog(),
    });

    const { res } = makeMockHttpResponse();
    const handled = await handler({ url: "/API//demo" } as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(routeHandler).toHaveBeenCalledTimes(1);
  });

  it("falls back to the provided registry when the pinned route registry is empty", async () => {
    const explicitRouteHandler = vi.fn(async (_req, res: ServerResponse) => {
      res.statusCode = 200;
      return true;
    });
    const startupRegistry = createTestRegistry();
    const explicitRegistry = createTestRegistry({
      httpRoutes: [createRoute({ path: "/demo", auth: "plugin", handler: explicitRouteHandler })],
    });

    setActivePluginRegistry(startupRegistry);
    pinActivePluginHttpRouteRegistry(startupRegistry);

    const handler = createGatewayPluginRequestHandler({
      registry: explicitRegistry,
      log: createPluginLog(),
    });

    const { res } = makeMockHttpResponse();
    const handled = await handler({ url: "/demo" } as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(explicitRouteHandler).toHaveBeenCalledTimes(1);
  });

  it("handles routes registered into the pinned startup registry after the active registry changes", async () => {
    const startupRegistry = createTestRegistry();
    const laterActiveRegistry = createTestRegistry();
    const routeHandler = vi.fn(async (_req, res: ServerResponse) => {
      res.statusCode = 202;
      return true;
    });

    setActivePluginRegistry(startupRegistry);
    pinActivePluginHttpRouteRegistry(startupRegistry);
    setActivePluginRegistry(laterActiveRegistry);

    const unregister = registerPluginHttpRoute({
      path: "/bluebubbles-webhook",
      auth: "plugin",
      handler: routeHandler,
    });

    try {
      const handler = createGatewayPluginRequestHandler({
        registry: startupRegistry,
        log: createPluginLog(),
      });

      const { res } = makeMockHttpResponse();
      const handled = await handler({ url: "/bluebubbles-webhook" } as IncomingMessage, res);
      expect(handled).toBe(true);
      expect(routeHandler).toHaveBeenCalledTimes(1);
      expect(laterActiveRegistry.httpRoutes).toHaveLength(0);
    } finally {
      unregister();
    }
  });

  it("prefers the pinned route registry over a stale explicit registry", async () => {
    const startupRegistry = createTestRegistry();
    const staleExplicitRegistry = createTestRegistry({
      httpRoutes: [createRoute({ path: "/plugins/diffs", auth: "plugin" })],
    });
    const routeHandler = vi.fn(async (_req, res: ServerResponse) => {
      res.statusCode = 204;
      return true;
    });

    setActivePluginRegistry(createTestRegistry());
    pinActivePluginHttpRouteRegistry(startupRegistry);

    const unregister = registerPluginHttpRoute({
      path: "/bluebubbles-webhook",
      auth: "plugin",
      handler: routeHandler,
    });

    try {
      const handler = createGatewayPluginRequestHandler({
        registry: staleExplicitRegistry,
        log: createPluginLog(),
      });

      const { res } = makeMockHttpResponse();
      const handled = await handler({ url: "/bluebubbles-webhook" } as IncomingMessage, res);
      expect(handled).toBe(true);
      expect(routeHandler).toHaveBeenCalledTimes(1);
      expect(staleExplicitRegistry.httpRoutes).toHaveLength(1);
      expect(startupRegistry.httpRoutes).toHaveLength(1);
    } finally {
      unregister();
    }
  });

  it("logs and responds with 500 when a route throws", async () => {
    const log = createPluginLog();
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          createRoute({
            path: "/boom",
            handler: async () => {
              throw new Error("boom");
            },
          }),
        ],
      }),
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

  it("enforces auth when any overlapping matched route requires gateway auth", () => {
    const registry = createTestRegistry({
      httpRoutes: [
        createRoute({ path: "/plugin/secure/report", match: "exact", auth: "plugin" }),
        createRoute({ path: "/plugin/secure", match: "prefix", auth: "gateway" }),
      ],
    });
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/plugin/secure/report")).toBe(true);
  });
});
