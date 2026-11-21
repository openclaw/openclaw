import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

function reply(statusCode: number, body?: string) {
  return vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = statusCode;
    res.end(body);
    return true;
  });
}

it.each([true, false])("routes MCP OAuth with callback configured=%s", async (configured) => {
  const callback = configured
    ? reply(200, "connected")
    : vi.fn((req: IncomingMessage, res: ServerResponse) =>
        handleMcpOAuthCallback(req, res, { config: {}, log: { warn: vi.fn() } }),
      );
  // Only the configured scenario has overlapping hooks; otherwise they would claim the fallthrough.
  const hooks = configured ? reply(405) : vi.fn(async () => false);
  const plugin = configured ? vi.fn(async () => false) : reply(200, "plugin");
  await withCallbackServer(
    {
      handleMcpOAuthCallbackRequest: callback,
      handleHooksRequest: hooks,
      handlePluginRequest: plugin,
      ...(!configured ? { shouldEnforcePluginGatewayAuth: () => false } : {}),
    },
    async (server) => {
      const response = await sendRequest(server, { path: callbackPath, method: "GET" });
      expect(response.res.statusCode).toBe(200);
      expect(response.getBody()).toBe(configured ? "connected" : "plugin");
      expect(callback).toHaveBeenCalledOnce();
      expect(hooks).toHaveBeenCalledTimes(configured ? 0 : 1);
      expect(plugin).toHaveBeenCalledTimes(configured ? 0 : 1);
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
