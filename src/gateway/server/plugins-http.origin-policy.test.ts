import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { resolveAcceptedBrowserOrigin } from "../../plugin-sdk/webhook-request-guards.js";
import type { PluginHttpRouteRegistration } from "../../plugins/registry.js";
import { makeMockHttpResponse } from "../test-http-response.js";
import { createGatewayTestRegistry } from "./__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "./plugins-http.js";

function createMockLogger(): SubsystemLogger {
  const child = vi.fn<(name: string) => SubsystemLogger>();
  const logger = {
    subsystem: "test/plugins-http-origin-policy",
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
  return logger;
}

describe("plugin HTTP origin policy", () => {
  it("carries mapped origins through dispatch without leaking them to other requests", async () => {
    const cfg: OpenClawConfig = { gateway: { publicOrigin: "https://old.example.test" } };
    let accepted: string | undefined;
    const route: PluginHttpRouteRegistration = {
      pluginId: "origin-proof",
      source: "origin-proof",
      path: "/origin-proof",
      auth: "gateway",
      match: "exact",
      handler: async (req) => {
        await Promise.resolve();
        accepted = resolveAcceptedBrowserOrigin({ req, cfg });
        return true;
      },
    };
    const handler = createGatewayPluginRequestHandler({
      registry: createGatewayTestRegistry({ httpRoutes: [route] }),
      log: createMockLogger(),
    });
    const request = async (origin: string, publishedPort?: number) => {
      const req = {
        url: route.path,
        headers: { origin, host: "gateway.example.test:18789" },
        socket: { remoteAddress: "198.51.100.4" },
      } as IncomingMessage;
      const response = makeMockHttpResponse();
      expect(
        await handler(req, response.res, undefined, {
          gatewayAuthSatisfied: true,
          gatewayRequestAuth: { authMethod: "token", trustDeclaredOperatorScopes: false },
          gatewayRequestOperatorScopes: ["operator.write"],
          publishedPort,
        }),
      ).toBe(true);
      return accepted;
    };

    const mappedOrigin = "http://localhost:25432";
    expect(await request(mappedOrigin, 25432)).toBe(mappedOrigin);
    expect(await request(mappedOrigin)).toBeUndefined();
    cfg.gateway!.publicOrigin = "https://new.example.test";
    expect(await request("https://old.example.test", 25432)).toBeUndefined();
    expect(await request("https://new.example.test", 25432)).toBe("https://new.example.test");
    expect(await request(mappedOrigin, 25432)).toBe(mappedOrigin);
    cfg.gateway!.controlUi = { allowedOrigins: [] };
    expect(await request(mappedOrigin, 25432)).toBeUndefined();
  });
});
