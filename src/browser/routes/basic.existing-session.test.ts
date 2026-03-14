import { describe, expect, it, vi } from "vitest";
import { BrowserProfileUnavailableError } from "../errors.js";
import { registerBrowserBasicRoutes } from "./basic.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

vi.mock("../chrome-mcp.js", () => ({
  getChromeMcpPid: vi.fn(() => 4321),
}));

describe("basic browser routes", () => {
  it("maps existing-session status failures to JSON browser errors", async () => {
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserBasicRoutes(app, {
      state: () => ({
        resolved: {
          enabled: true,
          headless: false,
          noSandbox: false,
          executablePath: undefined,
        },
        profiles: new Map(),
      }),
      forProfile: () =>
        ({
          profile: {
            name: "chrome-live",
            driver: "existing-session",
            cdpPort: 0,
            cdpUrl: "",
            color: "#00AA00",
            attachOnly: true,
          },
          isHttpReachable: async () => {
            throw new BrowserProfileUnavailableError("attach failed");
          },
          isReachable: async () => true,
        }) as never,
    } as never);

    const handler = getHandlers.get("/");
    expect(handler).toBeTypeOf("function");

    const response = createBrowserRouteResponse();
    await handler?.({ params: {}, query: { profile: "chrome-live" } }, response.res);

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ error: "attach failed" });
  });

  it("reports Chrome MCP transport without fake CDP fields", async () => {
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserBasicRoutes(app, {
      state: () => ({
        resolved: {
          enabled: true,
          headless: false,
          noSandbox: false,
          executablePath: undefined,
        },
        profiles: new Map(),
      }),
      forProfile: () =>
        ({
          profile: {
            name: "chrome-live",
            driver: "existing-session",
            cdpPort: 0,
            cdpUrl: "",
            color: "#00AA00",
            attachOnly: true,
          },
          isHttpReachable: async () => true,
          isReachable: async () => true,
        }) as never,
    } as never);

    const handler = getHandlers.get("/");
    expect(handler).toBeTypeOf("function");

    const response = createBrowserRouteResponse();
    await handler?.({ params: {}, query: { profile: "chrome-live" } }, response.res);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      profile: "chrome-live",
      driver: "existing-session",
      transport: "chrome-mcp",
      running: true,
      cdpPort: null,
      cdpUrl: null,
      pid: 4321,
    });
  });
});
