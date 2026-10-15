import { describe, expect, it } from "vitest";
import { SidebarSessionProjection } from "./app-sidebar-session-projection.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

type ProjectionInput = Parameters<SidebarSessionProjection["project"]>[0];

const connectionIdentity = {};
const listSource = {};

function sessionRow(
  key: string,
  overrides: Partial<SidebarRecentSession> = {},
): SidebarRecentSession {
  return {
    key,
    label: key,
    renameValue: "",
    active: false,
    visuallyActive: false,
    hasActiveRun: false,
    modelSelectionLocked: false,
    pinned: false,
    pinnable: true,
    cloudWorkerStopAction: null,
    hasAutomation: false,
    unread: false,
    attention: { kind: "none" },
    childSessionKeys: [],
    children: [],
    isChild: false,
    loadingChildren: false,
    containsActiveDescendant: false,
    runningChildCount: 0,
    failedChildCount: 0,
    ...overrides,
  };
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
    subtitle: {
      sidebarLiveActivity: true,
      showPreview: true,
      narrationLines: new Map(),
      observerDigests: new Map(),
    },
    ...overrides,
  };
}

function narrationInput(session: SidebarRecentSession, line: string): ProjectionInput {
  return projectionInput([session], {
    subtitle: {
      sidebarLiveActivity: true,
      showPreview: true,
      narrationLines: new Map([[session.key, line]]),
      observerDigests: new Map(),
    },
  });
}

function subtitleParams(
  session: SidebarRecentSession,
  overrides: Partial<Parameters<SidebarSessionProjection["resolveSubtitle"]>[0]> = {},
) {
  return {
    session,
    hasDisplay: false,
    sidebarLiveActivity: true,
    showPreview: true,
    narrationLine: undefined,
    ...overrides,
  };
}

describe("SidebarSessionProjection created order", () => {
  it("prunes only absent rows when the bounded registry exceeds its cap", () => {
    const projection = new SidebarSessionProjection();
    const original = Array.from({ length: 1_000 }, (_, index) => ({ key: `original-${index}` }));
    projection.observeRows([{ sessions: original }]);

    projection.observeRows([{ sessions: [{ key: "replacement" }, original[999]!] }]);

    expect(projection.createdOrder.size).toBe(1_000);
    expect(projection.createdOrder.has("original-0")).toBe(false);
    expect(projection.createdOrder.get("original-999")).toBe(999);
    expect(projection.createdOrder.get("replacement")).toBe(1_000);
  });

  it("promotes newly created sessions without losing the order of existing peers", () => {
    const projection = new SidebarSessionProjection();
    projection.observeRows([{ sessions: [{ key: "first" }, { key: "second" }] }]);

    expect(projection.promoteCreatedSession("newest")).toBe(true);
    expect(projection.promoteCreatedSession("newest")).toBe(false);
    expect([...projection.createdOrder]).toEqual([
      ["first", 1],
      ["second", 2],
      ["newest", 0],
    ]);
  });
});

describe("SidebarSessionProjection child expansion", () => {
  it("reveals newly added children while preserving a manual collapse through ordinary updates", () => {
    const projection = new SidebarSessionProjection();
    const parent = sessionRow("parent", { childSessionKeys: ["first", "second"] });
    projection.project(projectionInput([sessionRow(parent.key)]));
    projection.project(projectionInput([parent]));
    expect(projection.children.isExpanded(parent.key)).toBe(true);
    expect(projection.children.toggle(parent.key)).toEqual({ expanded: false });

    projection.project(
      projectionInput([sessionRow(parent.key, { childSessionKeys: ["second", "first"] })]),
    );
    expect(projection.children.isExpanded(parent.key)).toBe(false);

    // Compare identities, not counts: one child can replace another between snapshots.
    const replacement = sessionRow(parent.key, { childSessionKeys: ["second", "third"] });
    projection.project(projectionInput([replacement]));
    expect(projection.children.isExpanded(parent.key)).toBe(true);

    projection.children.showMore(parent.key);
    projection.project(
      projectionInput([
        sessionRow(parent.key, { childSessionKeys: ["second", "third", "fourth"] }),
      ]),
    );
    expect(projection.children.isFullyShown(parent.key)).toBe(true);
  });

  it("keeps existing children collapsed when the list replaces a route placeholder", () => {
    const projection = new SidebarSessionProjection();
    projection.project(projectionInput([sessionRow("parent")], { listLoaded: false }));
    const parent = sessionRow("parent", { childSessionKeys: ["first", "second"] });
    projection.project(projectionInput([parent]));
    expect(projection.children.isExpanded(parent.key)).toBe(false);

    projection.project(
      projectionInput([sessionRow(parent.key, { childSessionKeys: ["first", "second", "third"] })]),
    );
    expect(projection.children.isExpanded(parent.key)).toBe(true);
  });

  it("baselines restored collapsed children before revealing later additions", () => {
    const projection = new SidebarSessionProjection();
    const parent = sessionRow("parent", { childSessionKeys: ["first"] });
    projection.children.restore([{ key: parent.key, childrenDisplayMode: "collapsed-by-user" }]);
    projection.project(projectionInput([parent]));
    expect(projection.children.isExpanded(parent.key)).toBe(false);

    projection.project(
      projectionInput([sessionRow(parent.key, { childSessionKeys: ["first", "second"] })]),
    );
    expect(projection.children.isExpanded(parent.key)).toBe(true);
  });

  it("preserves restored expansion through the live handoff but clears it on a later connection", () => {
    const projection = new SidebarSessionProjection();
    const rows = [
      sessionRow("expanded"),
      sessionRow("fully-shown"),
      sessionRow("collapsed", { containsActiveDescendant: true }),
      sessionRow("untouched", { containsActiveDescendant: true }),
    ];
    projection.project(projectionInput([]));
    projection.children.restore([
      { key: "expanded", childrenDisplayMode: "expanded" },
      { key: "fully-shown", childrenDisplayMode: "expanded-fully" },
      { key: "collapsed", childrenDisplayMode: "collapsed-by-user" },
      { key: "untouched", childrenDisplayMode: projection.children.capture("untouched") },
    ]);
    expect(projection.children.isExpanded("expanded")).toBe(true);
    expect(projection.children.isFullyShown("fully-shown")).toBe(true);
    const liveConnection = {};
    projection.project(
      projectionInput(rows, { connectionIdentity: liveConnection, listSource: {} }),
    );
    expect(projection.children.isExpanded("expanded")).toBe(true);
    expect(projection.children.isFullyShown("fully-shown")).toBe(true);
    expect(projection.children.isExpanded("collapsed")).toBe(false);
    expect(projection.children.isExpanded("untouched")).toBe(true);
    projection.project(projectionInput(rows, { connectionIdentity: {} }));
    expect(projection.children.isExpanded("expanded")).toBe(false);
    expect(projection.children.isFullyShown("fully-shown")).toBe(false);
    expect(projection.children.isExpanded("collapsed")).toBe(true);
  });

  it("keeps an explicitly collapsed parent closed when a later descendant becomes active", () => {
    const projection = new SidebarSessionProjection();
    const active = sessionRow("parent", { containsActiveDescendant: true });
    projection.project(projectionInput([active]));
    expect(projection.children.toggle(active.key)).toEqual({ expanded: false });

    projection.project(projectionInput([sessionRow("parent")]));
    projection.project(projectionInput([active]));

    expect(projection.children.isExpanded("parent")).toBe(false);
  });

  it("forgets expansion when a session disappears before returning", () => {
    const projection = new SidebarSessionProjection();
    const parent = sessionRow("parent");
    projection.project(projectionInput([parent]));
    projection.children.toggle(parent.key);

    projection.project(projectionInput([]));
    projection.project(projectionInput([parent]));

    expect(projection.children.isExpanded(parent.key)).toBe(false);
  });
});

describe("SidebarSessionProjection running subtitle hold", () => {
  it("holds the subtitle across a run-id rotation while the session stays running", () => {
    // Live repro: queued->running rotates activeRunIds; the row must not blank.
    const projection = new SidebarSessionProjection();
    const running = sessionRow("running", { hasActiveRun: true, activeRunIds: ["run-one"] });
    projection.project(narrationInput(running, "Pre-rotation activity"));
    const rotated = sessionRow(running.key, { hasActiveRun: true, activeRunIds: ["run-two"] });
    projection.project(projectionInput([rotated]));

    expect(projection.resolveSubtitle(subtitleParams(rotated)).subtitle).toBe(
      "Pre-rotation activity",
    );
  });

  it("floors ambient subtitle replacement at the minimum display time", () => {
    let clock = 0;
    const projection = new SidebarSessionProjection(() => clock);
    const running = sessionRow("running", { hasActiveRun: true, activeRunIds: ["run-one"] });
    projection.project(narrationInput(running, "First activity"));

    clock = 500;
    projection.project(narrationInput(running, "Second activity"));
    expect(projection.resolveSubtitle(subtitleParams(running)).subtitle).toBe("First activity");

    clock = 2_500;
    projection.project(narrationInput(running, "Second activity"));
    expect(projection.resolveSubtitle(subtitleParams(running)).subtitle).toBe("Second activity");
  });

  it("lets operator-critical text replace a held subtitle immediately", () => {
    let clock = 0;
    const projection = new SidebarSessionProjection(() => clock);
    const running = sessionRow("running", { hasActiveRun: true, activeRunIds: ["run-one"] });
    projection.project(narrationInput(running, "Ambient activity"));

    clock = 200;
    const needsInput = sessionRow(running.key, {
      hasActiveRun: true,
      activeRunIds: ["run-one"],
      agentStatusNote: "Blocked on operator input",
    });
    projection.project(projectionInput([needsInput]));

    expect(projection.resolveSubtitle(subtitleParams(needsInput)).subtitle).toBe(
      "Blocked on operator input",
    );
  });

  it("clears held narration when the user disables live activity", () => {
    const projection = new SidebarSessionProjection();
    const running = sessionRow("running", { hasActiveRun: true, activeRunIds: ["run-one"] });
    projection.project(narrationInput(running, "Running checks"));

    projection.project(
      projectionInput([running], {
        subtitle: {
          sidebarLiveActivity: false,
          showPreview: true,
          narrationLines: new Map(),
          observerDigests: new Map(),
        },
      }),
    );

    expect(
      projection.resolveSubtitle(subtitleParams(running, { sidebarLiveActivity: false })),
    ).toEqual({ subtitle: undefined, narration: undefined });
  });

  it("never leaks a held backing-work subtitle into a catalog display that omits one", () => {
    const projection = new SidebarSessionProjection();
    const running = sessionRow("running", {
      hasActiveRun: true,
      activeRunIds: ["run-one"],
      workSession: true,
      subtitle: "~/Projects/openclaw",
    });
    projection.project(projectionInput([running]));

    expect(projection.resolveSubtitle(subtitleParams(running, { hasDisplay: true }))).toEqual({
      subtitle: undefined,
      narration: undefined,
    });
  });
});
