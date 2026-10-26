import { expect, it } from "vitest";
import { captureBootRoster } from "../lib/sessions/session-boot-roster.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import {
  parseSidebarSnapshot,
  restoreSnapshotSession,
  snapshotSections,
  snapshotSessions,
} from "./sidebar-snapshot-model.ts";
import { sidebarSnapshot as model } from "./sidebar-snapshot.test-support.ts";

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
    { key, label, pinned, isChild: false, children: [] },
    pinned ? key : "",
  );
}
const parse = (patch: Record<string, unknown>) => parseSidebarSnapshot({ ...model, ...patch });

it("roundtrips hidden-run child queries without retaining incognito parent keys", () => {
  const parent = displayRow("agent:main:parent", "Parent");
  const child = displayRow("agent:main:child", "Child");
  const hiddenRun = "agent:main:subagent:review";
  const incognitoRun = "agent:main:subagent:incognito-private";
  const captured = snapshotSessions([
    { ...parent, children: [child], childLoadParentKeys: [parent.key, hiddenRun, incognitoRun] },
  ]);
  expect(captured[0]?.childLoadParentKeys).toEqual([parent.key, hiddenRun]);
  const saved = parse(structuredClone({ sessions: captured }));
  const restored = restoreSnapshotSession(saved!.sessions[0]!, parent.key);
  expect(restored.childLoadParentKeys).toEqual([parent.key, hiddenRun]);
  expect(restored.children.map((row) => row.key)).toEqual([child.key]);
  const legacyParent = { ...captured[0], childLoadParentKeys: undefined };
  expect(parse({ sessions: [legacyParent] })).toBeNull();
  expect(parse({ sessions: [{ ...legacyParent, children: [] }] })).not.toBeNull();
  expect(
    parse({ sessions: [{ ...captured[0], childLoadParentKeys: [parent.key, incognitoRun] }] }),
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
  const roster = captureRoster([
    { ...stable, sharingRole: "owner", hasActiveRun: true, activeModel: "stale-model" },
    { key: "agent:main:private", kind: "direct", incognito: true, label: "Private title" },
  ]);
  const saved = parse({ roster });
  expect(saved?.roster?.result.sessions).toEqual([stable]);
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
  const saved = parse({ roster: captureRoster(sessions) });
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
    parse({ onlineUsers: [{ id: "operator", watchedSessions: ["private-session"] }] }),
  ).toBeNull();
});

it("excludes incognito roots and descendants and restores no live mutation facts", () => {
  const row = displayRow("agent:main:visible", "Project", true);
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
  const restored = restoreSnapshotSession(captured[0]!, row.key);
  expect(restored).toMatchObject({ visuallyActive: true, pinnable: false });
  expect([restored.sharingRole, restored.activeRunIds]).toEqual([undefined, undefined]);
});

it("omits incognito-only section metadata and counts while preserving existing empty groups", () => {
  const visible = displayRow("agent:main:public", "Public");
  const hidden = { ...visible, key: "agent:main:private", incognito: true };
  type Section = Parameters<typeof snapshotSections>[0][number];
  const section = (
    id: Section["id"],
    rows: Section["rows"],
    extra: Partial<Section> = {},
  ): Section => ({
    id,
    rows,
    totalRowCount: rows.length,
    visibleRowCount: rows.length,
    visibleLimit: 10,
    collapsedVisibleRowCount: rows.length,
    renderHeader: true,
    ...extra,
  });
  const sections = [
    section("project:private-path", [hidden], {
      project: { name: "Private project", path: "/private/project" },
    }),
    section("person:private-person", [hidden], {
      personOwner: { type: "human", id: "private-person", label: "Private person" },
    }),
    section("category:shared", [visible, hidden], { category: "Shared" }),
    section("category:empty", [], { category: "Empty" }),
  ];
  const captured = snapshotSections(
    sections,
    new Set([...sections.map(({ id }) => id), "online", "pinned", "category:gone"]),
  );
  const serialized = JSON.stringify(captured);
  const admitted = parse(JSON.parse(serialized));
  expect(admitted?.sections.map(({ id }) => id)).toEqual(["category:shared", "category:empty"]);
  expect(admitted?.sections[0]).toMatchObject({
    totalRowCount: 1,
    visibleRowCount: 1,
    collapsedVisibleRowCount: 1,
  });
  expect(admitted?.sections[1]?.totalRowCount).toBe(0);
  expect(admitted?.collapsedSections).toEqual([
    "category:shared",
    "category:empty",
    "online",
    "pinned",
  ]);
  expect(JSON.stringify(admitted)).not.toContain("private");
});
