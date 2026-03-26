import { describe, expect, it, vi } from "vitest";
import { BrowserProfileUnavailableError } from "../errors.js";
import { registerBrowserBasicRoutes } from "./basic.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

vi.mock("../chrome-mcp.js", () => ({
  getChromeMcpPid: vi.fn(() => 4321),
}));

describe("basic browser routes", () => {
  it("reports existing-session attach failures as not running with context", async () => {
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
            userDataDir: "/tmp/brave-profile",
            color: "#00AA00",
            attachOnly: true,
          },
          listTabs: async () => {
            throw new BrowserProfileUnavailableError("attach failed");
          },
          isHttpReachable: async () => false,
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
      transport: "chrome-mcp",
      running: false,
      tabCount: 0,
      availabilityError: "attach failed",
    });
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
            userDataDir: "/tmp/brave-profile",
            color: "#00AA00",
            attachOnly: true,
          },
          listTabs: async () => [
            { type: "page", targetId: "tab-1", title: "One", url: "https://example.com/1" },
            { type: "page", targetId: "tab-2", title: "Two", url: "https://example.com/2" },
          ],
          isHttpReachable: async () => false,
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
      tabCount: 2,
      cdpPort: null,
      cdpUrl: null,
      userDataDir: "/tmp/brave-profile",
      pid: 4321,
    });
  });
});
