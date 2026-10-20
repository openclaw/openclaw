import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runningRow as makeRunningRow } from "../test-helpers/app-sidebar-session-narration.ts";
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
    grouping: "category",
    knownGroups: [],
    collapsedSections: new Set(),
    emptyGroupsMode: "filtering",
    ownerFiltered: false,
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

it("keeps existing children collapsed when the list replaces a route placeholder", () => {
  project([sessionRow("parent")], { listLoaded: false });
  const parent = parentRow("first", "second");
  project([parent]);
  expect(projection.children.isExpanded(parent.key)).toBe(false);

  project([parentRow("first", "second", "third")]);
  expect(projection.children.isExpanded(parent.key)).toBe(true);
});

it("baselines restored collapsed children before revealing later additions", () => {
  const parent = parentRow("first");
  projection.children.restore([{ key: parent.key, childrenDisplayMode: "collapsed-by-user" }]);
  project([parent]);
  expect(projection.children.isExpanded(parent.key)).toBe(false);

  project([parentRow("first", "second")]);
  expect(projection.children.isExpanded(parent.key)).toBe(true);
});

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

it("holds the subtitle across a run-id rotation while the session stays running", () => {
  // Live repro: queued->running rotates activeRunIds; the row must not blank.
  const running = runningRow();
  narrate(running, "Pre-rotation activity");
  const rotated = runningRow({ activeRunIds: ["run-two"] });
  project([rotated]);
  expect(subtitle(rotated).subtitle).toBe("Pre-rotation activity");
});

it("floors ambient subtitle replacement at the minimum display time", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  const running = runningRow();
  narrate(running, "First activity");

  clock.mockReturnValue(500);
  narrate(running, "Second activity");
  expect(subtitle(running).subtitle).toBe("First activity");

  clock.mockReturnValue(2_500);
  narrate(running, "Second activity");
  expect(subtitle(running).subtitle).toBe("Second activity");
});

it("lets operator-critical text replace a held subtitle immediately", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  const running = runningRow();
  narrate(running, "Ambient activity");

  clock.mockReturnValue(200);
  const needsInput = runningRow({ agentStatusNote: "Blocked on operator input" });
  project([needsInput]);
  expect(subtitle(needsInput).subtitle).toBe("Blocked on operator input");
});

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
