import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { handleSessionHistoryHttpRequest } from "./sessions-history-http.js";

const { handleSessionHistoryHttpRequestMock } = vi.hoisted(() => ({
  handleSessionHistoryHttpRequestMock: vi.fn(),
}));

vi.mock("./sessions-history-http.js", () => ({
  handleSessionHistoryHttpRequest: handleSessionHistoryHttpRequestMock,
}));

import {
  AUTH_TOKEN,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

type SessionHistoryRouteOptions = Parameters<typeof handleSessionHistoryHttpRequest>[2];

describe("gateway sessions history route", () => {
  beforeEach(() => {
    handleSessionHistoryHttpRequestMock.mockReset();
  });

  it("passes getResolvedAuth through so session history can re-check rotated auth", async () => {
    let captured:
      | {
          auth?: ResolvedGatewayAuth;
          getResolvedAuth?: SessionHistoryRouteOptions["getResolvedAuth"];
        }
      | undefined;
    let currentAuth = AUTH_TOKEN;

    handleSessionHistoryHttpRequestMock.mockImplementation(
      async (
        _req: unknown,
        res: { statusCode: number; end: (body?: string) => void },
        opts: SessionHistoryRouteOptions,
      ) => {
        captured = opts;
        res.statusCode = 200;
        res.end("ok");
        return true;
      },
    );

    await withGatewayServer({
      prefix: "sessions-history-route",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        getResolvedAuth: () => currentAuth,
      },
      run: async (server) => {
        const req = createRequest({
          path: "/sessions/agent%3Amain/history",
          authorization: "Bearer test-token",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
        });
        const { res } = createResponse();
        await dispatchRequest(server, req, res);
      },
    });

    expect(handleSessionHistoryHttpRequestMock).toHaveBeenCalledTimes(1);
    expect(captured?.auth?.token).toBe("test-token");
    expect(captured?.getResolvedAuth).toBeTypeOf("function");

    currentAuth = {
      ...AUTH_TOKEN,
      token: "rotated-token",
    };

    expect(captured?.getResolvedAuth?.().token).toBe("rotated-token");
  });
});
