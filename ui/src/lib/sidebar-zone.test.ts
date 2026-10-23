import { describe, expect, it } from "vitest";
import { SIDEBAR_NAV_ROUTES, personalSessionPinKeys } from "../app-navigation.ts";
import { reconcileSidebarZone } from "./sidebar-zone.ts";

describe("reconcileSidebarZone", () => {
  it("persists a sidebar pin and independent rail shortcut for the same session", () => {
    const entries = ["session:agent:main:alpha", "session-rail:agent:main:alpha"];
    const result = reconcileSidebarZone(entries, [{ key: "agent:main:alpha" }], SIDEBAR_NAV_ROUTES);
    expect(result.sidebarEntries).toEqual(entries);
    expect(result.entries).toEqual([
      { type: "session", key: "agent:main:alpha" },
      { type: "session", key: "agent:main:alpha", rail: true },
    ]);
    expect([...personalSessionPinKeys(result.sidebarEntries)]).toEqual(["agent:main:alpha"]);
    expect([...personalSessionPinKeys(entries.slice(1))]).toEqual([]);
  });
  it("retains personal session refs without importing global pins", () => {
    const result = reconcileSidebarZone(
      ["session:agent:main:stale", "route:usage", "session:agent:main:alpha"],
      [{ key: "agent:main:alpha" }, { key: "agent:main:beta" }],
      SIDEBAR_NAV_ROUTES,
    );

    expect(result.sidebarEntries).toEqual([
      "session:agent:main:stale",
      "route:usage",
      "session:agent:main:alpha",
    ]);
    expect(result.entries).toEqual([
      { type: "route", route: "usage" },
      { type: "session", key: "agent:main:alpha" },
    ]);
  });

  it("migrates shipped Workboard placements to plugin destinations", () => {
    const result = reconcileSidebarZone(
      ["route:usage", "route:workboard", "workboard:ops"],
      [],
      SIDEBAR_NAV_ROUTES,
      new Set(["workboard/workboard", "workboard/board-ops"]),
    );
    expect(result.sidebarEntries).toEqual([
      "route:usage",
      "plugin:workboard/workboard",
      "plugin:workboard/board-ops",
    ]);
    expect(result.entries).toEqual([
      { type: "route", route: "usage" },
      { type: "plugin", key: "workboard/workboard" },
      { type: "plugin", key: "workboard/board-ops" },
    ]);
  });

  it("preserves unavailable plugin positions through reloads and permission loss", () => {
    const entries = ["plugin:example/review", "route:usage"];
    expect(reconcileSidebarZone(entries, [], SIDEBAR_NAV_ROUTES)).toEqual({
      entries: [{ type: "route", route: "usage" }],
      sidebarEntries: entries,
    });
    expect(
      reconcileSidebarZone(entries, [], SIDEBAR_NAV_ROUTES, new Set(["example/review"])).entries,
    ).toEqual([
      { type: "plugin", key: "example/review" },
      { type: "route", route: "usage" },
    ]);
  });
});
