import { describe, expect, it, vi } from "vitest";
import { AUTH_NONE, sendRequest, withGatewayServer } from "./server-http.test-harness.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";

const mocks = vi.hoisted(() => ({
  handleWorkspaceIconHttpRequest:
    vi.fn<typeof import("./workspace-icon-http.js").handleWorkspaceIconHttpRequest>(),
}));

vi.mock("./workspace-icon-http.js", () => ({
  handleWorkspaceIconHttpRequest: mocks.handleWorkspaceIconHttpRequest,
}));

vi.mock("./control-ui.js", () => {
  throw new Error("Control UI runtime is unavailable");
});

describe("Control UI HTTP loading", () => {
  it.each([
    { basePath: "", method: "POST", path: "/slack/events" },
    { basePath: "", method: "GET", path: "/api/unclaimed" },
    { basePath: "/console", method: "GET", path: "/outside-console" },
    {
      basePath: "",
      method: "POST",
      path: "/__openclaw__/assistant-media/extra?meta=1&allow=1",
    },
  ])("keeps $method $path independent of the UI runtime", async ({ basePath, method, path }) => {
    let ready = false;
    const handlePluginRequest = vi.fn(async () => false);
    const getGatewayRequestContext = vi.fn(() => undefined);
    await withGatewayServer({
      prefix: "control-ui-lazy-routing",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: basePath,
        handlePluginRequest,
        getGatewayRequestContext,
        shouldEnforcePluginGatewayAuth: () => false,
        isStartupPluginRuntimeReady: () => ready,
      },
      run: async (server) => {
        const starting = await sendRequest(server, { method, path });
        expect(starting.res.statusCode).toBe(503);
        expect(starting.getBody()).toBe("Plugin runtime is starting");
        expect(starting.setHeader).toHaveBeenCalledWith("Retry-After", "1");

        ready = true;
        const settled = await sendRequest(server, { method, path });
        expect(settled.res.statusCode).toBe(404);
        expect(settled.getBody()).toBe("Not Found");
        expect(handlePluginRequest).toHaveBeenCalledTimes(2);
        expect(getGatewayRequestContext).not.toHaveBeenCalled();
      },
    });
  });

  it("passes the current projection owner only to a claimed image route", async () => {
    const context = createGatewayRequestContext(makeContextParams());
    const getGatewayRequestContext = vi.fn(() => context);
    mocks.handleWorkspaceIconHttpRequest.mockImplementation(async (_req, res) => {
      res.statusCode = 204;
      res.end();
      return true;
    });
    await withGatewayServer({
      prefix: "control-ui-image-owner",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "/console",
        getGatewayRequestContext,
      },
      run: async (server) => {
        const owners = [{}, {}];
        for (const owner of owners) {
          context.sessionRowProjectionOwner = owner;
          const response = await sendRequest(server, {
            path: "/console/__openclaw__/workspace-icon/agent%3Amain%3Atest",
          });
          expect(response.res.statusCode).toBe(204);
          expect(
            mocks.handleWorkspaceIconHttpRequest.mock.lastCall?.[2].sessionRowProjectionOwner,
          ).toBe(owner);
        }
        expect(getGatewayRequestContext).toHaveBeenCalledTimes(owners.length);
      },
    });
  });
});
