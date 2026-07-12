import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { normalizeWorkspace } from "./index.ts";
import type { WorkspaceDocument, WorkspaceWidget } from "./types.ts";

function widget(overrides: Partial<WorkspaceWidget> & { id: string }): WorkspaceWidget {
  return {
    kind: "builtin:markdown",
    title: overrides.id,
    grid: { x: 0, y: 0, w: 4, h: 2 },
    collapsed: false,
    ...overrides,
  };
}

function workspace(version: number, tabs: WorkspaceDocument["tabs"]): WorkspaceDocument {
  return normalizeWorkspace({
    schemaVersion: 1,
    workspaceVersion: version,
    tabs,
    prefs: { tabOrder: tabs.map((tab) => tab.slug) },
    widgetsRegistry: {},
  });
}

describe("workspace history", () => {
  it("loads metadata and snapshots through the workspaces read RPCs", async () => {
    const history = await import("./history.ts");
    const request = vi.fn(async (method: string) =>
      method === "workspaces.history.list"
        ? {
            entries: [
              { version: 3, savedAt: "2026-07-08T00:00:00.000Z", bytes: 120 },
              { version: 0, savedAt: "", bytes: 0 },
              { nonsense: true },
            ],
          }
        : {
            doc: {
              schemaVersion: 1,
              workspaceVersion: 3,
              tabs: [{ slug: "main", title: "Main", hidden: false, widgets: [] }],
              prefs: { tabOrder: ["main"] },
              widgetsRegistry: {},
            },
          },
    );
    const client = { request } as unknown as GatewayBrowserClient;

    expect(await history.loadHistoryList(client)).toEqual([
      { version: 3, savedAt: "2026-07-08T00:00:00.000Z", bytes: 120 },
    ]);
    expect(await history.loadHistorySnapshot(client, 3)).toMatchObject({ workspaceVersion: 3 });
    expect(request).toHaveBeenNthCalledWith(1, "workspaces.history.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "workspaces.history.get", { version: 3 });
  });

  it("computes visible structural changes grouped by item creator provenance", async () => {
    const history = await import("./history.ts");
    const snapshot = workspace(3, [
      {
        slug: "main",
        title: "Main",
        hidden: false,
        createdBy: "system",
        widgets: [
          widget({ id: "a", title: "Alpha", createdBy: "agent:main" }),
          widget({ id: "b", title: "Bravo", createdBy: "user" }),
          widget({ id: "gone", createdBy: "user" }),
        ],
      },
      { slug: "ops", title: "Ops", hidden: false, createdBy: "agent:main", widgets: [] },
      { slug: "removed", title: "Removed", hidden: false, widgets: [] },
    ]);
    const current = workspace(6, [
      {
        slug: "main",
        title: "Main",
        hidden: false,
        createdBy: "system",
        widgets: [
          widget({
            id: "a",
            title: "Alpha 2",
            grid: { x: 0, y: 0, w: 6, h: 2 },
            createdBy: "agent:main",
          }),
          widget({ id: "c", title: "Charlie", createdBy: "agent:main" }),
        ],
      },
      {
        slug: "ops",
        title: "Operations",
        hidden: false,
        createdBy: "agent:main",
        widgets: [widget({ id: "b", title: "Bravo", createdBy: "user" })],
      },
      { slug: "added", title: "Added", hidden: false, widgets: [] },
    ]);

    const diff = history.computeWorkspaceStructuralDiff(snapshot, current);
    expect(diff.map((entry) => `${entry.kind}:${entry.id}`)).toEqual(
      expect.arrayContaining([
        "tab-added:added",
        "tab-removed:removed",
        "tab-retitled:ops",
        "widget-added:c",
        "widget-removed:gone",
        "widget-retitled:a",
        "widget-resized:a",
        "widget-moved:b",
      ]),
    );
    expect(diff.find((entry) => entry.kind === "widget-moved" && entry.id === "b")?.detail).toBe(
      "main → ops",
    );
    expect(
      history
        .groupDiffByCreator(diff)
        .find((group) => group.creator === "agent:main")
        ?.entries.some((entry) => entry.id === "c"),
    ).toBe(true);
    expect(diff.every((entry) => !("actor" in entry))).toBe(true);
  });

  it("reports exact, ranged, and unknown first-seen coverage without guessing", async () => {
    const history = await import("./history.ts");
    const snapAt = (version: number, ids: string[]) => ({
      version,
      workspace: workspace(version, [
        {
          slug: "main",
          title: "Main",
          hidden: false,
          widgets: ids.map((id) => widget({ id })),
        },
      ]),
    });

    expect(history.firstSeenVersion("b", [snapAt(1, ["a"]), snapAt(2, ["a", "b"])])).toEqual({
      kind: "exact",
      version: 2,
    });
    expect(history.firstSeenVersion("b", [snapAt(1, ["a"]), snapAt(3, ["a", "b"])])).toEqual({
      kind: "range",
      afterVersion: 1,
      byVersion: 3,
    });
    expect(history.firstSeenVersion("a", [snapAt(1, ["a"]), snapAt(2, ["a"])])).toEqual({
      kind: "unknown",
    });
    expect(history.firstSeenVersion("a", [])).toEqual({ kind: "unknown" });
  });
});
