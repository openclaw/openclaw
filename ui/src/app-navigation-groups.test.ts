// Control UI tests cover navigation groups behavior.
import { describe, expect, it } from "vitest";
import {
  SETTINGS_NAVIGATION_ROUTES,
  SIDEBAR_SECTIONS,
  isSettingsNavigationRoute,
} from "./app-navigation.ts";
import { routeIdFromPath } from "./app-routes.ts";

describe("SIDEBAR_SECTIONS", () => {
  it("keeps settings out of the scrollable sections; the footer pins it", () => {
    expect(SIDEBAR_SECTIONS.flatMap((group) => group.routes)).not.toContain("config");
    expect(SETTINGS_NAVIGATION_ROUTES.every((routeId) => isSettingsNavigationRoute(routeId))).toBe(
      true,
    );
    expect(isSettingsNavigationRoute("chat")).toBe(false);
  });

  it("keeps channel management out of the primary control sidebar", () => {
    const control = SIDEBAR_SECTIONS.find((group) => group.label === "control");
    expect(control?.routes).toEqual([
      "overview",
      "activity",
      "workboard",
      "instances",
      "sessions",
      "usage",
      "cron",
    ]);
    expect(SETTINGS_NAVIGATION_ROUTES).toContain("channels");
  });

  it("routes every published settings slice", () => {
    expect(routeIdFromPath("/communications")).toBe("communications");
    expect(routeIdFromPath("/appearance")).toBe("appearance");
    expect(routeIdFromPath("/automation")).toBe("automation");
    expect(routeIdFromPath("/infrastructure")).toBe("infrastructure");
    expect(routeIdFromPath("/ai-agents")).toBe("ai-agents");
    expect(routeIdFromPath("/config")).toBe("config");
    expect(routeIdFromPath("/channels")).toBe("channels");
  });
});
