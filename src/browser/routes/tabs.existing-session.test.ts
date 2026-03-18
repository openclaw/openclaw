import { describe, expect, it, vi } from "vitest";
import { registerBrowserTabRoutes } from "./tabs.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

describe("tabs routes existing-session", () => {
  it("lists tabs without a separate reachability probe", async () => {
    const { app, getHandlers } = createBrowserRouteApp();
    const isReachable = vi.fn(async () => true);
    const listTabs = vi.fn(async () => [
      {
        targetId: "7",
        title: "Qunar",
        url: "https://www.qunar.com",
        type: "page",
      },
    ]);

    registerBrowserTabRoutes(app, {
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
          isReachable,
          listTabs,
        }) as never,
      mapTabError: () => null,
    } as never);

    const handler = getHandlers.get("/tabs");
    expect(handler).toBeTypeOf("function");

    const response = createBrowserRouteResponse();
    await handler?.({ params: {}, query: { profile: "chrome-live" } }, response.res);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      running: true,
      tabs: [
        {
          targetId: "7",
          title: "Qunar",
          url: "https://www.qunar.com",
          type: "page",
        },
      ],
    });
    expect(listTabs).toHaveBeenCalledTimes(1);
    expect(isReachable).not.toHaveBeenCalled();
  });
});
