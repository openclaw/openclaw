import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { AUTH_NONE, sendRequest, withGatewayServer } from "./server-http.test-harness.js";

vi.mock("./control-ui.js", () => {
  throw new Error("Control UI runtime is unavailable");
});

// mock-isolation: Static HTTP routes must work when the optional media runtime cannot load.
vi.mock("./control-ui-assistant-media-http.js", () => {
  throw new Error("Assistant media runtime is unavailable");
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
    {
      basePath: "",
      method: "GET",
      path: "/__openclaw__/assistant-media?source=missing.png",
      rewritePath: "/api/unclaimed",
    },
  ])("keeps $method $path independent of the UI runtime", async (scenario) => {
    const { basePath, method, path } = scenario;
    let ready = false;
    const handlePluginRequest = vi.fn(async (req: IncomingMessage) => {
      if ("rewritePath" in scenario) {
        req.url = scenario.rewritePath;
      }
      return false;
    });
    await withGatewayServer({
      prefix: "control-ui-lazy-routing",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: basePath,
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => false,
        isStartupPluginRuntimeReady: () => ready,
      },
      run: async (server) => {
        const starting = await sendRequest(server, { method, path });
        expect(starting.res.statusCode).toBe(503);
        expect(starting.getBody()).toBe("Plugin runtime is starting");
        expect(starting.setHeader).toHaveBeenCalledWith("Retry-After", "1");
        expect(starting.setHeader).toHaveBeenCalledWith(
          "Content-Length",
          String(Buffer.byteLength("Plugin runtime is starting")),
        );

        ready = true;
        const settled = await sendRequest(server, { method, path });
        expect(settled.res.statusCode).toBe(404);
        expect(settled.getBody()).toBe("Not Found");
        expect(settled.setHeader).toHaveBeenCalledWith("Content-Length", "9");
        expect(handlePluginRequest).toHaveBeenCalledTimes(2);
      },
    });
  });
});
