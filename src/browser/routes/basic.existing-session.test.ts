import { describe, expect, it } from "vitest";
import { BrowserProfileUnavailableError } from "../errors.js";
import { registerBrowserBasicRoutes } from "./basic.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

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
            cdpPort: 18802,
            cdpUrl: "http://127.0.0.1:18802",
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
});
