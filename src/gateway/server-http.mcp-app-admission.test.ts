import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";

const handleMcpAppStandaloneHttpRequest = vi.hoisted(() => vi.fn());
// mock-isolation: suspend the standalone handler to observe Gateway admission independently.
vi.mock("./mcp-app-standalone.js", () => ({ handleMcpAppStandaloneHttpRequest }));

import { AUTH_NONE, sendRequest, withGatewayServer } from "./server-http.test-harness.js";

const MCP_APP_PATH = "/__openclaw__/mcp-app";

function withMcpAppServer(run: Parameters<typeof withGatewayServer>[0]["run"]) {
  return withGatewayServer({
    prefix: "mcp-app-http-admission",
    resolvedAuth: AUTH_NONE,
    overrides: {
      getRuntimeConfig: () => ({
        gateway: { trustedProxies: [] },
        mcp: { apps: { enabled: true } },
      }),
    },
    run,
  });
}

beforeEach(() => {
  resetGatewayWorkAdmission();
  handleMcpAppStandaloneHttpRequest.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
});

it("keeps deferred handler work visible until it settles", async () => {
  const started = createDeferred();
  const finish = createDeferred();
  handleMcpAppStandaloneHttpRequest.mockImplementation(
    async (_req: IncomingMessage, res: ServerResponse) => {
      started.resolve();
      await finish.promise;
      res.end("ok");
      return true;
    },
  );

  await withMcpAppServer(async (server) => {
    const pending = sendRequest(server, { path: MCP_APP_PATH });
    await started.promise;

    try {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      markGatewayRestartDraining();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    } finally {
      finish.resolve();
    }
    const response = await pending;
    expect(response.res.statusCode).toBe(200);
    // res.end() resolves the mock before admission's finally releases the root.
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });
});

it("releases admission when the standalone handler fails", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  handleMcpAppStandaloneHttpRequest.mockRejectedValue(new Error("standalone failed"));

  await withMcpAppServer(async (server) => {
    const response = await sendRequest(server, { path: MCP_APP_PATH });

    expect(response.res.statusCode).toBe(500);
    expect(response.getBody()).toBe("Internal Server Error");
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(errorLog).toHaveBeenCalledWith(
      "[gateway-http] unhandled error in request handler:",
      expect.objectContaining({ message: "standalone failed" }),
    );
  });
});
