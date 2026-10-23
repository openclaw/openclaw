import { describe, expect, it } from "vitest";
import { personalSessionPinKeys } from "../app-navigation.ts";
import { buildReconciledSidebarZone } from "../components/app-sidebar-session-navigation-logic.ts";
import { projectSidebarSession } from "../components/app-sidebar-session-navigation.test-support.ts";

function reconcile(
  sidebarEntries: string[],
  sessions: readonly { key: string }[] = [],
  pluginTabs: Parameters<typeof buildReconciledSidebarZone>[0]["pluginTabs"] = [],
) {
  const { entries, sidebarEntries: canonical } = buildReconciledSidebarZone({
    sidebarEntries,
    rows: sessions.map((row) => projectSidebarSession(row)),
    pluginNavigation: [],
    pluginTabs,
  });
  return { entries, sidebarEntries: canonical };
}

describe("sidebar zone", () => {
  it("persists a sidebar pin and independent rail shortcut for the same session", () => {
    const entries = ["session:agent:main:alpha", "session-rail:agent:main:alpha"];
    const result = reconcile(entries, [{ key: "agent:main:alpha" }]);
    expect(result.sidebarEntries).toEqual(entries);
    expect(result.entries).toEqual([
      { type: "session", key: "agent:main:alpha" },
      { type: "session", key: "agent:main:alpha", rail: true },
    ]);
    expect([...personalSessionPinKeys(result.sidebarEntries)]).toEqual(["agent:main:alpha"]);
    expect([...personalSessionPinKeys(entries.slice(1))]).toEqual([]);
  });
  it("retains personal session refs without importing global pins", () => {
    const result = reconcile(
      ["session:agent:main:stale", "route:usage", "session:agent:main:alpha"],
      [{ key: "agent:main:alpha" }, { key: "agent:main:beta" }],
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
    const result = reconcile(
      ["route:usage", "route:workboard", "workboard:ops"],
      [],
      [
        { pluginId: "workboard", id: "workboard", label: "Workboard" },
        { pluginId: "workboard", id: "board-ops", label: "Operations" },
      ],
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
    expect(reconcile(entries)).toEqual({
      entries: [{ type: "route", route: "usage" }],
      sidebarEntries: entries,
    });
    expect(
      reconcile(entries, [], [{ pluginId: "example", id: "review", label: "Review" }]).entries,
    ).toEqual([
      { type: "plugin", key: "example/review" },
      { type: "route", route: "usage" },
    ]);
  });
});
