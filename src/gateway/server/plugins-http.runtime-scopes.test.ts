import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  releasePinnedPluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { makeMockHttpResponse } from "../test-http-response.js";
import { createTestRegistry } from "./__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "./plugins-http.js";

function createRoute(params: {
  path: string;
  auth: "gateway" | "plugin";
  handler?: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;
}) {
  return {
    pluginId: "route",
    path: params.path,
    auth: params.auth,
    match: "exact" as const,
    handler: params.handler ?? (() => true),
    source: "route",
  };
}

function createMockLogger(): SubsystemLogger {
  const child = vi.fn<(name: string) => SubsystemLogger>();
  const logger = {
    subsystem: "test/plugins-http-runtime-scopes",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child,
  } satisfies SubsystemLogger;
  child.mockImplementation(() => logger);
  return logger as SubsystemLogger;
}

function assertWriteHelperAllowed() {
  const scopes = getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes ?? [];
  const auth = authorizeOperatorScopesForMethod("agent", scopes);
  if (!auth.allowed) {
    throw new Error(`missing scope: ${auth.missingScope}`);
  }
}

describe("plugin HTTP route runtime scopes", () => {
  afterEach(() => {
    releasePinnedPluginHttpRouteRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  async function invokeRoute(params: {
    path: string;
    auth: "gateway" | "plugin";
    gatewayAuthSatisfied: boolean;
  }) {
    const log = createMockLogger();
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          createRoute({
            path: params.path,
            auth: params.auth,
            handler: async () => {
              assertWriteHelperAllowed();
              return true;
            },
          }),
        ],
      }),
      log,
    });

    const response = makeMockHttpResponse();
    const handled = await handler(
      { url: params.path } as IncomingMessage,
      response.res,
      undefined,
      { gatewayAuthSatisfied: params.gatewayAuthSatisfied },
    );
    return { handled, log, ...response };
  }

  it("keeps plugin-auth routes off write-capable runtime helpers", async () => {
    const { handled, res, setHeader, end, log } = await invokeRoute({
      path: "/hook",
      auth: "plugin",
      gatewayAuthSatisfied: false,
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(500);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
    expect(end).toHaveBeenCalledWith("Internal Server Error");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("missing scope: operator.write"));
  });

  it("preserves write-capable runtime helpers on gateway-auth routes", async () => {
    const { handled, res, log } = await invokeRoute({
      path: "/secure-hook",
      auth: "gateway",
      gatewayAuthSatisfied: true,
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    {
      auth: "plugin" as const,
      gatewayAuthSatisfied: false,
      path: "/hook",
      expectedScopes: [],
    },
    {
      auth: "gateway" as const,
      gatewayAuthSatisfied: true,
      path: "/secure-hook",
      expectedScopes: ["operator.write"],
    },
  ])(
    "maps $auth routes to $expectedScopes",
    async ({ auth, gatewayAuthSatisfied, path, expectedScopes }) => {
      let observedScopes: string[] | undefined;
      const handler = createGatewayPluginRequestHandler({
        registry: createTestRegistry({
          httpRoutes: [
            createRoute({
              path,
              auth,
              handler: vi.fn(async () => {
                observedScopes =
                  getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [];
                return true;
              }),
            }),
          ],
        }),
        log: createMockLogger(),
      });

      const { res } = makeMockHttpResponse();
      const handled = await handler({ url: path } as IncomingMessage, res, undefined, {
        gatewayAuthSatisfied,
      });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(observedScopes).toEqual(expectedScopes);
    },
  );
});
