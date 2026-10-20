import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { handleMcpOAuthCallback } from "./mcp-oauth-callback.js";
import { AUTH_TOKEN, sendRequest, withGatewayServer } from "./server-http.test-harness.js";

const callbackPath = "/oauth/mcp/callback?code=code&state=state";

function withCallbackServer(
  overrides: Parameters<typeof withGatewayServer>[0]["overrides"],
  run: Parameters<typeof withGatewayServer>[0]["run"],
) {
  return withGatewayServer({
    prefix: "mcp-oauth-callback",
    resolvedAuth: AUTH_TOKEN,
    overrides,
    run,
  });
}

beforeEach(() => resetGatewayWorkAdmission());
afterEach(() => resetGatewayWorkAdmission());

describe("Gateway MCP OAuth callback route", () => {
  it("claims the callback before a hooks path that overlaps /oauth", async () => {
    const callback = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.end("connected");
      return true;
    });
    const plugin = vi.fn(async () => false);
    // A hooks.path of "/oauth" would otherwise 405 the provider redirect.
    const hooks = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 405;
      res.end();
      return true;
    });

    await withCallbackServer(
      {
        handleMcpOAuthCallbackRequest: callback,
        handleHooksRequest: hooks,
        handlePluginRequest: plugin,
      },
      async (server) => {
        const response = await sendRequest(server, { path: callbackPath, method: "GET" });

        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toBe("connected");
        expect(callback).toHaveBeenCalledOnce();
        expect(hooks).not.toHaveBeenCalled();
        expect(plugin).not.toHaveBeenCalled();
      },
    );
  });

  it("leaves wrong methods and paths outside the callback stage", async () => {
    const callback = vi.fn(async () => false);

    await withCallbackServer({ handleMcpOAuthCallbackRequest: callback }, async (server) => {
      for (const request of [
        { path: "/oauth/mcp/callback", method: "POST" },
        { path: "/oauth/other", method: "GET" },
      ]) {
        const response = await sendRequest(server, request);
        expect(response.res.statusCode).toBe(404);
      }
      expect(callback).not.toHaveBeenCalled();
    });
  });

  it("falls through to plugin routing when requester OAuth is not configured", async () => {
    const callback = vi.fn((req: IncomingMessage, res: ServerResponse) =>
      handleMcpOAuthCallback(req, res, { config: {}, log: { warn: vi.fn() } }),
    );
    const plugin = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.end("plugin");
      return true;
    });

    await withCallbackServer(
      {
        handleMcpOAuthCallbackRequest: callback,
        handlePluginRequest: plugin,
        shouldEnforcePluginGatewayAuth: () => false,
      },
      async (server) => {
        const response = await sendRequest(server, { path: callbackPath, method: "GET" });

        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toBe("plugin");
        expect(callback).toHaveBeenCalledOnce();
        expect(plugin).toHaveBeenCalledOnce();
      },
    );
  });

  it("rejects callback work after Gateway admission closes", async () => {
    const callback = vi.fn(async () => false);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    try {
      await withCallbackServer({ handleMcpOAuthCallbackRequest: callback }, async (server) => {
        const response = await sendRequest(server, { path: callbackPath });

        expect(response.res.statusCode).toBe(503);
        expect(JSON.parse(response.getBody())).toMatchObject({
          error: { code: "gateway_unavailable" },
        });
        expect(callback).not.toHaveBeenCalled();
      });
    } finally {
      suspension?.release();
    }
  });
});
