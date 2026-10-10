// Proves standalone MCP App HTTP work participates in Gateway suspension admission.
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";

const mocks = vi.hoisted(() => ({
  handleMcpAppStandaloneHttpRequest: vi.fn(),
}));

vi.mock("./mcp-app-standalone.js", () => ({
  handleMcpAppStandaloneHttpRequest: mocks.handleMcpAppStandaloneHttpRequest,
}));

import {
  AUTH_NONE,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

const MCP_APP_PATH = "/__openclaw__/mcp-app";

function mcpAppsConfig(): OpenClawConfig {
  return {
    gateway: { trustedProxies: [] },
    mcp: { apps: { enabled: true } },
  };
}

async function withMcpAppServer(
  run: (server: Parameters<typeof dispatchRequest>[0]) => Promise<void>,
): Promise<void> {
  await withGatewayServer({
    prefix: "mcp-app-http-admission",
    resolvedAuth: AUTH_NONE,
    overrides: { getRuntimeConfig: mcpAppsConfig },
    run,
  });
}

beforeEach(() => {
  resetGatewayWorkAdmission();
  mocks.handleMcpAppStandaloneHttpRequest.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
});

describe("standalone MCP App HTTP admission", () => {
  it("keeps deferred handler work visible until it settles", async () => {
    const started = createDeferred();
    const finish = createDeferred();
    mocks.handleMcpAppStandaloneHttpRequest.mockImplementation(
      async (_req: IncomingMessage, res: ServerResponse) => {
        started.resolve();
        await finish.promise;
        res.statusCode = 200;
        res.end("ok");
        return true;
      },
    );

    await withMcpAppServer(async (server) => {
      const response = createResponse();
      const pending = dispatchRequest(server, createRequest({ path: MCP_APP_PATH }), response.res);
      await started.promise;

      try {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        markGatewayRestartDraining();
        expect(getActiveGatewayRootWorkCount()).toBe(1);
      } finally {
        finish.resolve();
      }
      await pending;
      expect(response.res.statusCode).toBe(200);
      // The response mock resolves from res.end(), immediately before the
      // admission wrapper's finally block releases the request root.
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    });
  });

  it("releases admission when the standalone handler fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.handleMcpAppStandaloneHttpRequest.mockRejectedValue(new Error("standalone failed"));

    await withMcpAppServer(async (server) => {
      const response = createResponse();
      await dispatchRequest(server, createRequest({ path: MCP_APP_PATH }), response.res);

      expect(response.res.statusCode).toBe(500);
      expect(response.getBody()).toBe("Internal Server Error");
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(errorLog).toHaveBeenCalledWith(
        "[gateway-http] unhandled error in request handler:",
        expect.objectContaining({ message: "standalone failed" }),
      );
    });
  });
});
