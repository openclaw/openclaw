import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_NONE,
  createRequest,
  createResponse,
  createTestGatewayServer,
  dispatchRequest,
  withGatewayTempConfig,
} from "./server-http.test-harness.js";

const mocks = vi.hoisted(() => ({
  handleTeamsHttpRequest: vi.fn(
    async (_req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end('{"ok":true,"route":"teams"}');
      return true;
    },
  ),
}));

vi.mock("./teams-http.js", () => ({
  handleTeamsHttpRequest: mocks.handleTeamsHttpRequest,
}));

describe("Gateway Teams HTTP routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches Teams account routes before the Control UI SPA catch-all", async () => {
    await withGatewayTempConfig("openclaw-teams-http-route-", async () => {
      const server = createTestGatewayServer({
        resolvedAuth: AUTH_NONE,
        overrides: {
          controlUiEnabled: true,
          controlUiBasePath: "/",
        },
      });
      const req = createRequest({
        path: "/api/teams/session",
        headers: { origin: "http://localhost:18789" },
      });
      const response = createResponse();

      await dispatchRequest(server, req, response.res);

      expect(response.res.statusCode).toBe(200);
      expect(response.getBody()).toBe('{"ok":true,"route":"teams"}');
      expect(mocks.handleTeamsHttpRequest).toHaveBeenCalledOnce();
    });
  });

  it("dispatches dynamic Teams owner invite routes before the Control UI SPA catch-all", async () => {
    await withGatewayTempConfig("openclaw-teams-http-route-", async () => {
      const server = createTestGatewayServer({
        resolvedAuth: AUTH_NONE,
        overrides: {
          controlUiEnabled: true,
          controlUiBasePath: "/",
        },
      });
      const req = createRequest({
        method: "DELETE",
        path: "/api/teams/invites/invite-1",
        headers: { origin: "http://localhost:18789", "content-type": "application/json" },
      });
      const response = createResponse();

      await dispatchRequest(server, req, response.res);

      expect(response.res.statusCode).toBe(200);
      expect(response.getBody()).toBe('{"ok":true,"route":"teams"}');
      expect(mocks.handleTeamsHttpRequest).toHaveBeenCalledOnce();
    });
  });
});
