import { describe, expect, test, vi } from "vitest";

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: () => undefined,
  getOAuthProviders: () => [],
}));

import {
  AUTH_TOKEN,
  expectUnauthorizedResponse,
  sendRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

describe("gateway control UI growth HTTP auth", () => {
  test("requires shared auth for remote growth routes while allowing local direct access", async () => {
    await withGatewayServer({
      prefix: "openclaw-control-ui-growth-auth-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "/openclaw",
        controlUiRoot: { kind: "missing" },
      },
      run: async (server) => {
        const summaryPath = "/openclaw/__openclaw/growth-foundation.json";
        const filePath =
          "/openclaw/__openclaw/growth-foundation/file?path=memory%2Fprojects%2Fgrowth-foundation%2Factions%2Fcurrent.md";
        const reviewPath = "/openclaw/__openclaw/growth-foundation/review-action";

        expectUnauthorizedResponse(
          await sendRequest(server, {
            path: summaryPath,
            host: "gateway.example:18789",
            remoteAddress: "203.0.113.10",
          }),
          "summary remote unauthenticated",
        );
        expectUnauthorizedResponse(
          await sendRequest(server, {
            path: filePath,
            host: "gateway.example:18789",
            remoteAddress: "203.0.113.10",
          }),
          "file remote unauthenticated",
        );
        expectUnauthorizedResponse(
          await sendRequest(server, {
            path: reviewPath,
            method: "POST",
            host: "gateway.example:18789",
            remoteAddress: "203.0.113.10",
          }),
          "review-action remote unauthenticated",
        );

        const authenticated = await sendRequest(server, {
          path: summaryPath,
          authorization: "Bearer test-token",
          host: "gateway.example:18789",
          remoteAddress: "203.0.113.10",
        });
        expect(authenticated.res.statusCode).toBe(200);
        expect(authenticated.getBody()).toContain('"available":false');

        const localDirect = await sendRequest(server, { path: summaryPath });
        expect(localDirect.res.statusCode).toBe(200);
        expect(localDirect.getBody()).toContain('"available":false');
      },
    });
  });
});
