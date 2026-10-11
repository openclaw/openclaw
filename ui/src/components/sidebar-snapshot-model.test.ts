import { describe, expect, it } from "vitest";
import { captureBootRoster } from "../lib/sessions/session-boot-roster.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import {
  parseSidebarSnapshot,
  restoreSnapshotSession,
  snapshotSections,
  snapshotSessions,
  type SidebarSnapshotModel,
} from "./sidebar-snapshot-model.ts";

const model: SidebarSnapshotModel = {
  routingDefaults: { mainKey: "main", scope: "per-sender" },
  roster: null,
  mode: "roster",
  navigationView: "sessions",
  pages: [],
  pageScopeId: null,
  pinnedSessions: [],
  entries: [],
  sessions: [],
  sections: [],
  cards: [],
  collapsedAgentIds: [],
  collapsedSections: [],
  plugins: [],
  onlineUsers: [],
  onlineCounts: [],
  peopleSortMode: "presence",
  peopleStatusFilter: "all",
  onlineExpanded: false,
  ownerId: null,
  involvingMe: false,
  footer: { id: "operator", name: "Riley" },
  brand: { name: "Harbor", avatar: null, icon: "claw", environment: null },
};

describe("sidebar display snapshot admission", () => {
  it("keeps primary routing and header facts in the display snapshot without private or live authority", () => {
    const stable = {
      key: "agent:main:dashboard:cedar",
      kind: "direct" as const,
      displayName: "Cedar",
      boardFace: "dashboard" as const,
      boardPresentation: "expanded" as const,
      workspaceDir: "/synthetic/workspace",
    };
    const liveRow = {
      ...stable,
      sharingRole: "owner" as const,
      hasActiveRun: true,
      activeModel: "stale-model",
    };
    Reflect.set(liveRow, "incognito", false);
    const roster = captureBootRoster({
      result: sessionsResult(
        [
          liveRow,
          { key: "agent:main:private", kind: "direct", incognito: true, label: "Private title" },
        ],
        1,
      ),
      agentId: "main",
      groups: [],
      groupSettings: [],
      sectionOrder: [],
      loading: false,
      error: null,
    });
    const saved = parseSidebarSnapshot({ ...model, roster });
    expect(saved?.roster?.result.sessions).toEqual([stable]);
    expect(JSON.stringify(saved)).not.toMatch(
      /Private title|sharingRole|hasActiveRun|activeModel/u,
    );
    expect(
      parseSidebarSnapshot({
        ...saved,
        roster: { ...roster, result: sessionsResult([{ ...stable, incognito: true }], 1) },
      }),
    ).toBeNull();
  });

  it("keeps display data without persisting authority, executable plugins, or watched sessions", () => {
    const admitted = parseSidebarSnapshot({
      ...model,
      token: "synthetic-secret",
      footer: { ...model.footer, scopes: ["operator.admin"] },
      plugins: [
        { key: "reports/main", pluginId: "reports", id: "main", label: "Reports", mount() {} },
      ],
      cards: [
        {
          id: "main",
          name: "Harbor",
          mainKey: "agent:main:main",
          activeNow: true,
          unreadCount: 3,
          lastActiveAt: 99,
        },
      ],
    });
    expect(admitted?.footer).toEqual(model.footer);
    expect(admitted?.plugins).toEqual([
      { key: "reports/main", pluginId: "reports", id: "main", label: "Reports" },
    ]);
    expect(admitted).not.toHaveProperty("token");
    expect(admitted?.cards).toEqual([{ id: "main", name: "Harbor", mainKey: "agent:main:main" }]);
    expect(
      parseSidebarSnapshot({
        ...model,
        onlineUsers: [{ id: "operator", watchedSessions: ["private-session"] }],
      }),
    ).toBeNull();
  });

  it("excludes incognito roots and descendants and restores no live mutation facts", () => {
    const row = restoreSnapshotSession(
      { key: "agent:main:visible", label: "Project", pinned: true, isChild: false, children: [] },
      "agent:main:visible",
    );
    const privateRow = { ...row, key: "agent:main:private", incognito: true };
    const captured = snapshotSessions(
      [
        { ...row, children: [privateRow], sharingRole: "owner", activeRunIds: ["live-run"] },
        privateRow,
      ],
      () => ({ snapshotSubtitle: { subtitle: "Private child approval details" } }),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.children).toEqual([]);
    expect(captured[0]?.snapshotSubtitle).toBeUndefined();
    expect(JSON.stringify(captured)).not.toContain("Private child approval details");
    const restored = restoreSnapshotSession(captured[0]!, row.key);
    expect(restored.visuallyActive).toBe(true);
    expect(restored.pinnable).toBe(false);
    expect(restored.sharingRole).toBeUndefined();
    expect(restored.activeRunIds).toBeUndefined();
  });

  it("omits incognito-only section metadata and counts while preserving existing empty groups", () => {
    const visible = restoreSnapshotSession(
      { key: "agent:main:public", label: "Public", pinned: false, isChild: false, children: [] },
      "",
    );
    const hidden = { ...visible, key: "agent:main:private", incognito: true };
    const counts = {
      totalRowCount: 2,
      visibleRowCount: 2,
      visibleLimit: 10,
      collapsedVisibleRowCount: 2,
      renderHeader: true,
    };
    const captured = snapshotSections(
      [
        {
          ...counts,
          id: "project:private-path",
          project: { name: "Private project", path: "/private/project" },
          rows: [hidden],
        },
        {
          ...counts,
          id: "person:private-person",
          personOwner: { type: "human", id: "private-person", label: "Private person" },
          rows: [hidden],
        },
        { ...counts, id: "category:shared", category: "Shared", rows: [visible, hidden] },
        {
          ...counts,
          id: "category:empty",
          category: "Empty",
          rows: [],
          totalRowCount: 0,
          visibleRowCount: 0,
          collapsedVisibleRowCount: 0,
        },
      ],
      new Set([
        "project:private-path",
        "person:private-person",
        "category:shared",
        "category:empty",
        "online",
      ]),
    );
    const admitted = parseSidebarSnapshot({ ...model, ...captured });
    expect(admitted?.sections.map((section) => section.id)).toEqual([
      "category:shared",
      "category:empty",
    ]);
    expect(admitted?.sections[0]).toMatchObject({
      totalRowCount: 1,
      visibleRowCount: 1,
      collapsedVisibleRowCount: 1,
    });
    expect(admitted?.sections[1]?.totalRowCount).toBe(0);
    expect(admitted?.collapsedSections).toEqual(["category:shared", "category:empty", "online"]);
    expect(JSON.stringify(admitted)).not.toContain("private");
  });
});
