import { expect, it } from "vitest";
import { captureBootRoster } from "../lib/sessions/session-boot-roster.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import {
  parseSidebarSnapshot,
  restoreSnapshotSession,
  createSidebarSnapshotRows,
  snapshotSections,
} from "./sidebar-snapshot-model.ts";
import {
  sidebarSnapshot as model,
  sidebarSnapshotWithRows,
} from "./sidebar-snapshot.test-support.ts";

function captureRoster(rows: Parameters<typeof sessionsResult>[0]) {
  return captureBootRoster({
    result: sessionsResult(rows, 1),
    agentId: "main",
    groups: [],
    groupSettings: [],
    sectionOrder: [],
    loading: false,
    error: null,
  });
}
function displayRow(key: string, label: string, pinned = false) {
  return restoreSnapshotSession(
    { ...model, rows: { [key]: { label, pinned, isChild: false, children: [] } } },
    key,
    pinned ? key : "",
  );
}

it("keeps unread and state presentation at the cached-to-live handoff", () => {
  const row = {
    ...displayRow("agent:main:work", "Work"),
    unread: true,
    status: "failed" as const,
    hasAutomation: true,
    runningChildCount: 2,
    failedChildCount: 1,
    unreadChildCount: 3,
  };
  const captured = sidebarSnapshotWithRows([row]);
  const saved = parseSidebarSnapshot(JSON.parse(JSON.stringify(captured)));
  expect(saved).not.toBeNull();
  expect(restoreSnapshotSession(saved!, saved!.sessions[0]!, "")).toMatchObject({
    unread: true,
    hasAutomation: true,
    hasActiveRun: false,
    runningChildCount: 0,
    failedChildCount: 0,
    snapshot: { run: "subagents", slotActive: 2, slotUnread: 4, slotFailed: true },
  });
  expect(JSON.stringify(saved)).not.toMatch(/subagentSummary|hasActiveRun|runningChildCount/);
});

it("stores a row once across saved placements without retaining request content", () => {
  const row = {
    ...displayRow("agent:main:work", "Only one visible row title"),
    participantCount: 1,
    participants: [{ identity: { type: "profile" as const, id: "alex" }, label: "Alex visible" }],
    attention: {
      kind: "approval" as const,
      requests: [
        {
          id: "private-request",
          kind: "approval" as const,
          count: 1,
          createdAtMs: 1,
          preview: "Hidden approval request payload",
        },
      ],
    },
  };
  const owner = {
    type: "human" as const,
    id: "alex",
    label: "Alex visible",
    identity: { type: "profile" as const, id: "alex" },
  };
  const captured = sidebarSnapshotWithRows([row], () => ({
    owner,
    viewers: [{ id: "alex", name: owner.label, identity: owner.identity, watchedSessions: [] }],
  }));
  captured.pages = captured.sessions;
  captured.pinnedSessions = captured.sessions;
  const encoded = JSON.stringify(captured);
  expect(encoded.match(/Only one visible row title/gu)).toHaveLength(1);
  expect(captured.rows[row.key]?.participants).toHaveLength(1);
  expect(encoded).not.toContain("Hidden approval request payload");
  const saved = parseSidebarSnapshot(JSON.parse(encoded));
  expect(saved).not.toBeNull();
  const restored = restoreSnapshotSession(saved!, row.key, row.key);
  expect(restored.snapshot?.attention).toEqual(["approval", "shieldQuestion"]);
  expect(restored.attention).toEqual({ kind: "none" });
});

it("reuses boot roster headers and stores only visible overlays for held rows", () => {
  const roster = captureRoster([
    { key: "agent:main:held", kind: "direct", label: "Held title", icon: "🔧", pinned: true },
  ]);
  const held = { ...displayRow("agent:main:held", "Held title", true), icon: "🔧", unread: true };
  const offRoster = displayRow("agent:main:old-pin", "Off-roster pin", true);
  const saved = sidebarSnapshotWithRows([held, offRoster], undefined, roster);
  expect(saved.rows[held.key]).not.toHaveProperty("icon");
  expect(saved.rows[held.key]?.label).toBeUndefined();
  expect(JSON.stringify(saved).match(/Held title/gu)).toHaveLength(1);
  expect(restoreSnapshotSession(saved, held.key, "")).toMatchObject({
    label: "Held title",
    icon: "🔧",
    pinned: true,
    unread: true,
  });
  expect(restoreSnapshotSession(saved, offRoster.key, "")).toMatchObject({
    label: "Off-roster pin",
    pinned: true,
  });
});

it("discards malformed row references instead of restoring another row or recursing", () => {
  const captured = sidebarSnapshotWithRows([displayRow("agent:main:work", "Work")]);
  const key = captured.sessions[0]!;
  expect(parseSidebarSnapshot({ ...captured, pinnedSessions: ["agent:main:missing"] })).toBeNull();
  captured.rows[key]!.children = [key];
  captured.rows[key]!.childLoadParentKeys = [key];
  expect(parseSidebarSnapshot(captured)).toBeNull();
});

it("roundtrips hidden-run child queries without retaining incognito parent keys", () => {
  const parent = displayRow("agent:main:parent", "Parent");
  const child = displayRow("agent:main:child", "Child");
  const hiddenRun = "agent:main:subagent:review";
  const incognitoRun = "agent:main:subagent:incognito-private";
  const captured = sidebarSnapshotWithRows([
    { ...parent, children: [child], childLoadParentKeys: [parent.key, hiddenRun, incognitoRun] },
  ]);
  expect(captured.rows[parent.key]?.childLoadParentKeys).toEqual([parent.key, hiddenRun]);
  const saved = parseSidebarSnapshot(structuredClone(captured));
  expect(saved).not.toBeNull();
  const restored = restoreSnapshotSession(saved!, saved!.sessions[0]!, parent.key);
  expect(restored.childLoadParentKeys).toEqual([parent.key, hiddenRun]);
  expect(restored.children.map((row) => row.key)).toEqual([child.key]);
  const legacyParent = { ...captured.rows[parent.key], childLoadParentKeys: undefined };
  expect(
    parseSidebarSnapshot({ ...captured, rows: { ...captured.rows, [parent.key]: legacyParent } }),
  ).toBeNull();
  expect(
    parseSidebarSnapshot({
      ...captured,
      rows: { ...captured.rows, [parent.key]: { ...legacyParent, children: [] } },
    }),
  ).not.toBeNull();
  expect(
    parseSidebarSnapshot({
      ...captured,
      rows: {
        ...captured.rows,
        [parent.key]: {
          ...captured.rows[parent.key],
          childLoadParentKeys: [parent.key, incognitoRun],
        },
      },
    }),
  ).toBeNull();
});

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
  const roster = captureRoster([
    liveRow,
    { key: "agent:main:private", kind: "direct", incognito: true, label: "Private title" },
  ]);
  const saved = parseSidebarSnapshot({ ...model, roster });
  expect(saved?.roster?.result.sessions).toEqual([stable]);
  expect(JSON.stringify(saved)).not.toMatch(/Private title|sharingRole|hasActiveRun|activeModel/u);
  expect(
    parseSidebarSnapshot({
      ...saved,
      roster: { ...roster, result: sessionsResult([{ ...stable, incognito: true }], 1) },
    }),
  ).toBeNull();
});

it("admits the sidebar after the live roster grows beyond the boot window", () => {
  const sessions = Array.from({ length: 240 }, (_, index) => ({
    key: `agent:main:session-${index}`,
    kind: "direct" as const,
    label: `Session ${index}`,
  }));
  const roster = captureRoster(sessions);
  const saved = parseSidebarSnapshot({ ...model, roster });
  expect(saved?.roster?.result.sessions).toEqual(sessions.slice(0, 200));
});

it("keeps display data without persisting authority, executable plugins, or watched sessions", () => {
  const plugin = { key: "reports/main", pluginId: "reports", id: "main", label: "Reports" };
  const card = { id: "main", name: "Harbor", mainKey: "agent:main:main" };
  const admitted = parseSidebarSnapshot({
    ...model,
    token: "synthetic-secret",
    footer: { ...model.footer, scopes: ["operator.admin"] },
    plugins: [{ ...plugin, mount() {} }],
    cards: [{ ...card, activeNow: true, lastActiveAt: 99 }],
  });
  expect(admitted?.footer).toEqual(model.footer);
  expect(admitted?.plugins).toEqual([plugin]);
  expect(admitted?.cards).toEqual([card]);
  expect(admitted).not.toHaveProperty("token");
  expect(
    parseSidebarSnapshot({
      ...model,
      onlineUsers: [{ id: "operator", watchedSessions: ["private-session"] }],
    }),
  ).toBeNull();
});

it("excludes incognito roots and descendants and restores no live mutation facts", () => {
  const row = displayRow("agent:main:visible", "Project", true);
  const privateRow = { ...row, key: "agent:main:private", incognito: true };
  const captured = sidebarSnapshotWithRows(
    [
      { ...row, children: [privateRow], sharingRole: "owner", activeRunIds: ["live-run"] },
      privateRow,
    ],
    () => ({ snapshotSubtitle: { subtitle: "Private child approval details" } }),
  );
  expect(captured.sessions).toHaveLength(1);
  expect(captured.rows[row.key]?.children).toEqual([]);
  expect(captured.rows[row.key]?.snapshotSubtitle).toBeUndefined();
  expect(JSON.stringify(captured)).not.toContain("Private child approval details");
  const restored = restoreSnapshotSession(captured, row.key, row.key);
  expect(restored).toMatchObject({ visuallyActive: true, pinnable: false });
  expect([restored.sharingRole, restored.activeRunIds]).toEqual([undefined, undefined]);
});

it("omits incognito-only section metadata and counts while preserving existing empty groups", () => {
  const visible = displayRow("agent:main:public", "Public");
  const hidden = { ...visible, key: "agent:main:private", incognito: true };
  const counts = {
    totalRowCount: 2,
    visibleRowCount: 2,
    visibleLimit: 10,
    collapsedVisibleRowCount: 2,
    renderHeader: true,
  };
  const sections: Parameters<typeof snapshotSections>[0] = [
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
  ];
  const snapshot = createSidebarSnapshotRows();
  const captured = snapshotSections(
    sections,
    new Set([...sections.map(({ id }) => id), "online"]),
    snapshot.capture,
  );
  const admitted = parseSidebarSnapshot({
    ...model,
    rows: snapshot.rows,
    ...captured,
  });
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

it("retains independently rendered Pinned collapse state through snapshot serialization", () => {
  const captured = snapshotSections(
    [],
    new Set(["pinned", "online", "category:gone"]),
    createSidebarSnapshotRows().capture,
  );
  const serialized = JSON.stringify({ ...model, ...captured });
  const saved = parseSidebarSnapshot(JSON.parse(serialized));
  expect(saved?.collapsedSections).toEqual(["pinned", "online"]);
});
