import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runningRow as makeRunningRow } from "../test-helpers/app-sidebar-session-narration.ts";
import { sidebarVisibleRowsInOrder } from "./app-sidebar-personal-navigation.ts";
import { SidebarSessionProjection } from "./app-sidebar-session-projection.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

type ProjectionInput = Parameters<SidebarSessionProjection["project"]>[0];

const connectionIdentity = {};
const listSource = {};

let projection: SidebarSessionProjection;
beforeEach(() => {
  projection = new SidebarSessionProjection();
});
afterEach(() => vi.restoreAllMocks());
const project = (rows: SidebarRecentSession[], overrides: Partial<ProjectionInput> = {}) =>
  projection.project(projectionInput(rows, overrides));
const sectionIds = (rows: SidebarRecentSession[], overrides: Partial<ProjectionInput>) =>
  project(rows, overrides).sections.map(({ id }) => id);
const runningRow = (overrides: Partial<SidebarRecentSession> = {}) =>
  sessionRow("running", { hasActiveRun: true, activeRunIds: ["run-one"], ...overrides });
const parentRow = (...childSessionKeys: string[]) => sessionRow("parent", { childSessionKeys });
const subtitleEnvironment = (sidebarLiveActivity = true): ProjectionInput["subtitle"] => ({
  sidebarLiveActivity,
  showPreview: true,
  narrationLines: new Map(),
  observerDigests: new Map(),
});

function sessionRow(
  key: string,
  overrides: Partial<SidebarRecentSession> = {},
): SidebarRecentSession {
  const { updatedAt: _updatedAt, startedAt: _startedAt, ...row } = makeRunningRow(key);
  return { ...row, label: key, hasActiveRun: false, ...overrides };
}

function projectionInput(
  rows: SidebarRecentSession[],
  overrides: Partial<ProjectionInput> = {},
): ProjectionInput {
  return {
    rows,
    selectedSessionKey: null,
    grouping: "category",
    knownGroups: [],
    collapsedSections: new Set(),
    emptyGroupsMode: "filtering",
    ownerFilter: null,
    visibleSessionLimits: new Map(),
    sortMode: "created",
    statusFilter: "active",
    agentId: "main",
    connectionIdentity,
    listSource,
    listLoaded: true,
    subtitle: subtitleEnvironment(),
    ...overrides,
  };
}

const narrate = (session: SidebarRecentSession, line: string) =>
  project([session], {
    subtitle: { ...subtitleEnvironment(), narrationLines: new Map([[session.key, line]]) },
  });

function subtitle(
  session: SidebarRecentSession,
  overrides: Partial<Parameters<SidebarSessionProjection["resolveSubtitle"]>[0]> = {},
) {
  return projection.resolveSubtitle({
    session,
    hasDisplay: false,
    sidebarLiveActivity: true,
    showPreview: true,
    narrationLine: undefined,
    ...overrides,
  });
}

describe("SidebarSessionProjection personal pins", () => {
  it("excludes collapsed and archived pins from selection order", () => {
    const pin = sessionRow("pin");
    const archived = sessionRow("archived", { archived: true });
    const pending = sessionRow("pending");
    const plain = sessionRow("plain");
    const zone = {
      entries: [pin, archived, pending].map((row) => ({ type: "session" as const, key: row.key })),
      sessionRows: new Map([pin, archived, pending].map((row) => [row.key, row])),
    };
    const visibility = {
      collapsedSessionSections: new Set<string>(),
      sessionDataContext: {
        sessions: {
          archiveVisibility: (key: string) =>
            key === "pending" ? ("pending" as const) : undefined,
        },
      },
    };
    expect(sidebarVisibleRowsInOrder(zone, [plain], visibility)).toEqual([pin, plain]);
    expect(
      sidebarVisibleRowsInOrder(zone, [plain], {
        ...visibility,
        collapsedSessionSections: new Set(["pinned"]),
      }),
    ).toEqual([plain]);
  });
  it("lists active pins only in Pinned and names the remaining sessions Other", () => {
    const rows = [
      sessionRow("agent:main:pinned"),
      sessionRow("agent:main:archived", { archived: true }),
      sessionRow("agent:main:plain"),
    ];
    const pinnedKeys = new Set(["agent:main:pinned", "agent:main:archived"]);
    for (const grouping of ["category", "none"] as const) {
      const { sections, visibleRows } = new SidebarSessionProjection().project(
        projectionInput(rows, { grouping, pinnedKeys }),
      );
      const ungrouped = sections.find((section) => section.id === "ungrouped")!;
      // Archived pins stay in place so the archived view can still list them.
      expect(ungrouped.rows.map((row) => row.key)).toEqual([
        "agent:main:archived",
        "agent:main:plain",
      ]);
      expect(ungrouped.renderHeader).toBe(true);
      expect(visibleRows.map((row) => row.key)).not.toContain("agent:main:pinned");
    }
    const { sections } = new SidebarSessionProjection().project(
      projectionInput(rows, { grouping: "none" }),
    );
    expect(sections.find((section) => section.id === "ungrouped")!.renderHeader).toBe(false);
  });
});

it("hides empty filtered native groups and preserves other section owners", () => {
  const rows = [sessionRow("matching", { category: "Matching" })];
  const input = {
    statusFilter: "active" as const,
    knownGroups: ["Matching", "Empty"],
    catalogIds: ["external"],
    collapsedSections: new Set(["category:Matching"]),
  };
  const filtered = project(rows, input);
  expect(filtered.sections.map(({ id }) => id)).toEqual(["category:Matching", "catalog:external"]);
  expect(filtered.sections[0]).toMatchObject({ totalRowCount: 1, visibleRowCount: 0 });
  const unfiltered = project(rows, { ...input, statusFilter: "all" });
  expect(unfiltered.sections.map(({ id }) => id)).toContain("category:Empty");
  expect(unfiltered.sections[0]).toMatchObject({ totalRowCount: 1, visibleRowCount: 0 });
  expect(sectionIds(rows, { ...input, emptyGroupsMode: "never" })).toContain("category:Empty");
});

it("retains unloaded group destinations until the session list establishes their contents", () => {
  const input = { knownGroups: ["Awaiting sessions"], statusFilter: "active" as const };
  expect(sectionIds([], { ...input, listLoaded: false })).toContain("category:Awaiting sessions");
  expect(sectionIds([], input)).not.toContain("category:Awaiting sessions");
});

it("renders a single selected owner's sessions inline instead of under a person header", () => {
  const owned = (key: string, id: string) =>
    sessionRow(key, {
      owner: { actor: { type: "human", id, identity: { type: "profile", id } } },
    });
  const headers = (rows: SidebarRecentSession[], overrides: Partial<ProjectionInput>) =>
    project(rows, { grouping: "person", selfOwnerId: "patrick", ...overrides })
      .sections.filter((section) => section.id.startsWith("person:"))
      .map((section) => [section.id, section.renderHeader, section.visibleRowCount]);

  expect(
    headers([owned("mine", "patrick")], {
      ownerFilter: "owner",
      collapsedSections: new Set(["person:profile:patrick"]),
    }),
  ).toEqual([["person:profile:patrick", false, 1]]);
  expect(
    headers([owned("mine", "patrick"), owned("theirs", "ada")], { ownerFilter: "involvingMe" }),
  ).toEqual([
    ["person:profile:patrick", true, 1],
    ["person:profile:ada", true, 1],
  ]);
  expect(headers([owned("mine", "patrick")], { ownerFilter: null })).toEqual([
    ["person:profile:patrick", true, 1],
  ]);
});

it("prunes only absent rows when the bounded registry exceeds its cap", () => {
  const original = Array.from({ length: 1_000 }, (_, index) => ({ key: `original-${index}` }));
  projection.observeRows([{ sessions: original }]);
  projection.observeRows([{ sessions: [{ key: "replacement" }, original[999]!] }]);
  expect(projection.createdOrder.size).toBe(1_000);
  expect(projection.createdOrder.has("original-0")).toBe(false);
  expect(projection.createdOrder.get("original-999")).toBe(999);
  expect(projection.createdOrder.get("replacement")).toBe(1_000);
});

it("promotes newly created sessions without losing the order of existing peers", () => {
  projection.observeRows([{ sessions: [{ key: "first" }, { key: "second" }] }]);
  expect(projection.promoteCreatedSession("newest")).toBe(true);
  expect(projection.promoteCreatedSession("newest")).toBe(false);
  expect([...projection.createdOrder]).toEqual([
    ["first", 1],
    ["second", 2],
    ["newest", 0],
  ]);
});

it("reveals newly added children while preserving a manual collapse through ordinary updates", () => {
  const parent = parentRow("first", "second");
  project([sessionRow(parent.key)]);
  project([parent]);
  expect(projection.children.isExpanded(parent.key)).toBe(true);
  expect(projection.children.toggle(parent.key)).toEqual({ expanded: false });

  project([parentRow("second", "first")]);
  expect(projection.children.isExpanded(parent.key)).toBe(false);

  // Compare identities, not counts: one child can replace another between snapshots.
  project([parentRow("second", "third")]);
  expect(projection.children.isExpanded(parent.key)).toBe(true);

  projection.children.showMore(parent.key);
  project([parentRow("second", "third", "fourth")]);
  expect(projection.children.isFullyShown(parent.key)).toBe(true);
});

it.each(["route placeholder", "restored collapse"])(
  "baselines children from a %s before revealing additions",
  (origin) => {
    if (origin === "route placeholder") {
      project([sessionRow("parent")], { listLoaded: false });
    } else {
      projection.children.restore([{ key: "parent", childrenDisplayMode: "collapsed-by-user" }]);
    }
    project([parentRow("first")]);
    expect(projection.children.isExpanded("parent")).toBe(false);
    project([parentRow("first", "second")]);
    expect(projection.children.isExpanded("parent")).toBe(true);
  },
);

it("preserves restored expansion through the live handoff but clears it on a later connection", () => {
  const rows = [
    sessionRow("expanded"),
    sessionRow("fully-shown"),
    sessionRow("collapsed", { containsActiveDescendant: true }),
    sessionRow("untouched", { containsActiveDescendant: true }),
  ];
  project([]);
  projection.children.restore([
    { key: "expanded", childrenDisplayMode: "expanded" },
    { key: "fully-shown", childrenDisplayMode: "expanded-fully" },
    { key: "collapsed", childrenDisplayMode: "collapsed-by-user" },
    { key: "untouched", childrenDisplayMode: projection.children.capture("untouched") },
  ]);
  expect(projection.children.isExpanded("expanded")).toBe(true);
  expect(projection.children.isFullyShown("fully-shown")).toBe(true);
  const liveConnection = {};
  project(rows, { connectionIdentity: liveConnection, listSource: {} });
  expect(projection.children.isExpanded("expanded")).toBe(true);
  expect(projection.children.isFullyShown("fully-shown")).toBe(true);
  expect(projection.children.isExpanded("collapsed")).toBe(false);
  expect(projection.children.isExpanded("untouched")).toBe(true);
  project(rows, { connectionIdentity: {} });
  expect(projection.children.isExpanded("expanded")).toBe(false);
  expect(projection.children.isFullyShown("fully-shown")).toBe(false);
  expect(projection.children.isExpanded("collapsed")).toBe(true);
});

it("keeps an explicitly collapsed parent closed when a later descendant becomes active", () => {
  const active = sessionRow("parent", { containsActiveDescendant: true });
  project([active]);
  expect(projection.children.toggle(active.key)).toEqual({ expanded: false });
  project([sessionRow("parent")]);
  project([active]);
  expect(projection.children.isExpanded("parent")).toBe(false);
});

it("forgets expansion when a session disappears before returning", () => {
  const parent = sessionRow("parent");
  project([parent]);
  projection.children.toggle(parent.key);
  project([]);
  project([parent]);
  expect(projection.children.isExpanded(parent.key)).toBe(false);
});

it.each([
  ["run-id rotation", { activeRunIds: ["run-two"] }, undefined, "First activity"],
  ["ambient replacement", {}, "Second activity", "First activity"],
  ["operator-critical replacement", { agentStatusNote: "Blocked" }, undefined, "Blocked"],
] satisfies [string, Partial<SidebarRecentSession>, string | undefined, string][])(
  "holds subtitles through %s according to urgency",
  (_name, fields, nextLine, expected) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    narrate(runningRow(), "First activity");
    const next = runningRow(fields);
    clock.mockReturnValue(200);
    if (nextLine) {
      narrate(next, nextLine);
    } else {
      project([next]);
    }
    expect(subtitle(next).subtitle).toBe(expected);
    if (nextLine) {
      clock.mockReturnValue(2_500);
      narrate(next, nextLine);
      expect(subtitle(next).subtitle).toBe(nextLine);
    }
  },
);

it("clears held narration when the user disables live activity", () => {
  const running = runningRow();
  narrate(running, "Running checks");

  project([running], { subtitle: subtitleEnvironment(false) });

  expect(subtitle(running, { sidebarLiveActivity: false })).toEqual({
    subtitle: undefined,
    narration: undefined,
  });
});

it("never leaks a held backing-work subtitle into a catalog display that omits one", () => {
  const running = runningRow({ workSession: true, subtitle: "~/Projects/openclaw" });
  project([running]);
  expect(subtitle(running, { hasDisplay: true })).toEqual({
    subtitle: undefined,
    narration: undefined,
  });
});

it("reveals late active ancestry once per navigation without changing other disclosure choices", () => {
  const treeProjection = new SidebarSessionProjection();
  const leaf = sessionRow("leaf", { active: true, visuallyActive: true });
  const middle = sessionRow("middle", {
    children: [leaf],
    childSessionKeys: [leaf.key],
    containsActiveDescendant: true,
  });
  const root = sessionRow("root", {
    children: [middle],
    childSessionKeys: [middle.key],
    containsActiveDescendant: true,
  });
  const runningChild = sessionRow("unrelated-running", { hasActiveRun: true });
  const unrelated = sessionRow("unrelated", {
    children: [runningChild],
    childSessionKeys: [runningChild.key],
    containsActiveDescendant: true,
  });
  treeProjection.children.restore(
    [root, middle, unrelated].map(({ key }) => ({
      key,
      childrenDisplayMode: "collapsed-by-user",
    })),
  );
  const projectTree = (
    rows: SidebarRecentSession[],
    selectedSessionKey: string | null = leaf.key,
  ) => treeProjection.project(projectionInput(rows, { selectedSessionKey }));
  projectTree([leaf, unrelated]);
  expect(treeProjection.children.selectedRootKey).toBeNull();
  projectTree([sessionRow(root.key), unrelated]);
  expect(treeProjection.children.isExpanded(root.key)).toBe(false);
  projectTree([root, unrelated]);
  expect(treeProjection.children.isExpanded(root.key)).toBe(true);
  expect(treeProjection.children.isExpanded(middle.key)).toBe(true);
  expect(treeProjection.children.isExpanded(unrelated.key)).toBe(false);
  treeProjection.children.showMore(root.key);
  treeProjection.children.toggle(middle.key);
  projectTree([root, unrelated]);
  expect(treeProjection.children.isFullyShown(root.key)).toBe(true);
  expect(treeProjection.children.isExpanded(middle.key)).toBe(false);
  // A partial refresh is not a navigation away from the selected session.
  projectTree([
    {
      ...root,
      containsActiveDescendant: false,
      children: [
        { ...middle, children: [], loadingChildren: true, containsActiveDescendant: false },
      ],
    },
    unrelated,
  ]);
  projectTree([root, unrelated]);
  expect(treeProjection.children.isExpanded(middle.key)).toBe(false);
  projectTree([unrelated], null);
  projectTree([root, unrelated]);
  expect(treeProjection.children.isExpanded(middle.key)).toBe(true);
  expect(treeProjection.children.isExpanded(unrelated.key)).toBe(false);
});

it("keeps the selected descendant's root visible beyond the first sidebar page", () => {
  const treeProjection = new SidebarSessionProjection();
  const selected = sessionRow("selected", { active: true, visuallyActive: true });
  const ancestor = sessionRow("older-ancestor", {
    childSessionKeys: [selected.key],
    children: [selected],
    containsActiveDescendant: true,
  });
  const quietRoots = Array.from({ length: 30 }, (_, index) => sessionRow("quiet-" + index));
  const projected = treeProjection.project(
    projectionInput([...quietRoots, ancestor], { grouping: "none" }),
  );
  expect(treeProjection.children.isExpanded(ancestor.key)).toBe(true);
  expect(projected.sections.flatMap(({ rows }) => rows.map(({ key }) => key))).toContain(
    ancestor.key,
  );
});
