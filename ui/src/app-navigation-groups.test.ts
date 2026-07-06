// Control UI tests cover sidebar pinned-route customization behavior.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_PINNED_ROUTES,
  SETTINGS_NAVIGATION_ROUTES,
  SIDEBAR_NAV_ROUTES,
  isSettingsNavigationRoute,
  normalizeSidebarPinnedRoutes,
  sidebarMoreRoutes,
} from "./app-navigation.ts";
import { routeIdFromPath } from "./app-routes.ts";

describe("sidebar pinned routes", () => {
  it("defaults to a small pinned set drawn from the customizable routes", () => {
    expect(DEFAULT_SIDEBAR_PINNED_ROUTES.length).toBeLessThan(SIDEBAR_NAV_ROUTES.length);
    for (const routeId of DEFAULT_SIDEBAR_PINNED_ROUTES) {
      expect(SIDEBAR_NAV_ROUTES).toContain(routeId);
    }
  });

  it("keeps managed worktrees in the customizable sidebar", () => {
    expect(SIDEBAR_NAV_ROUTES).toContain("worktrees");
  });

  it("keeps channel management and settings slices out of the customizable sidebar", () => {
    expect(SIDEBAR_NAV_ROUTES).not.toContain("channels");
    expect(SIDEBAR_NAV_ROUTES).not.toContain("config");
    expect(SETTINGS_NAVIGATION_ROUTES).toContain("channels");
    expect(SETTINGS_NAVIGATION_ROUTES.every((routeId) => isSettingsNavigationRoute(routeId))).toBe(
      true,
    );
  });

  it("normalizes persisted pinned routes, dropping unknown and duplicate entries", () => {
    expect(
      normalizeSidebarPinnedRoutes(["worktrees", "overview", "worktrees", "bogus", 7]),
    ).toEqual(["worktrees", "overview"]);
    expect(normalizeSidebarPinnedRoutes([])).toEqual([]);
  });

  it("falls back to null for non-list values so callers use defaults", () => {
    expect(normalizeSidebarPinnedRoutes(undefined)).toBeNull();
    expect(normalizeSidebarPinnedRoutes({ overview: true })).toBeNull();
    expect(normalizeSidebarPinnedRoutes("overview")).toBeNull();
  });

  it("puts every unpinned nav route into the More section", () => {
    const pinned = ["overview", "worktrees"] as const;
    const more = sidebarMoreRoutes(pinned);
    expect(more).not.toContain("overview");
    expect(more).not.toContain("worktrees");
    expect(new Set([...pinned, ...more])).toEqual(new Set(SIDEBAR_NAV_ROUTES));
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
