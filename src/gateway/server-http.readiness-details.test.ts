import { describe, expect, it } from "vitest";
import {
  AUTH_NONE,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import type { ReadinessChecker } from "./server/readiness.js";

describe("gateway readiness HTTP details", () => {
  it("returns canonical conditions for local requests", async () => {
    const condition = {
      type: "ConfigLoaded",
      status: "True",
      requirement: "required",
      reason: "ConfigLoaded",
      message: "Runtime configuration loaded.",
    } as const;
    const getReadiness: ReadinessChecker = async () => ({
      ready: true,
      failing: [],
      uptimeMs: 45_000,
      conditions: [condition],
      failures: [],
    });

    await withGatewayServer({
      prefix: "probe-hosting-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/ready" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual({
          ready: true,
          failing: [],
          uptimeMs: 45_000,
          conditions: [condition],
          failures: [],
        });
      },
    });
  });
});
