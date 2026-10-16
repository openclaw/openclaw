import { createComponent } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { ControlUiHost, ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { ControlUiRegistration } from "../plugins/control-ui-capability.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { collectKnownSessionRows, fetchSessionLineage } from "./app-sidebar-child-session-data.ts";
import {
  buildReconciledSidebarZone,
  buildSidebarSessionNavigationState,
  collectSidebarSessionRowsByKey,
  createSidebarSessionRowsComparator,
  resolveSidebarMainSessionKey,
} from "./app-sidebar-session-navigation-logic.ts";
import { projectSidebarSession } from "./app-sidebar-session-navigation.test-support.ts";
import { projectSessionTree } from "./app-sidebar-session-tree.ts";
import type { SidebarSessionAttention } from "./app-sidebar-session-types.ts";
import { TeamSessionSlots } from "./solid/session-presentation.tsx";

function sidebarRow(row: GatewaySessionRow, isChild?: boolean) {
  return { ...projectSidebarSession(row), isChild: isChild === true };
}
type TreeOptions = Partial<Parameters<typeof projectSessionTree>[0]>;
function projectTree(
  roots: GatewaySessionRow[],
  rows: GatewaySessionRow[],
  options: TreeOptions = {},
) {
  return projectSessionTree({
    roots,
    rowsByKey: collectSidebarSessionRowsByKey({ rows, childRowsByParent: {} }),
    loadingChildKeys: new Set(),
    resolveAttention: () => ({ kind: "none" }),
    toSidebarSession: sidebarRow,
    ...options,
  });
}
const direct = (key: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key,
  kind: "direct",
  ...fields,
});
const placement = (
  fields: Partial<NonNullable<GatewaySessionRow["placement"]>> = {},
): NonNullable<GatewaySessionRow["placement"]> => ({
  state: "active",
  generation: 1,
  createdAtMs: 1,
  updatedAtMs: 1,
  stateChangedAtMs: 1,
  environmentId: "worker:device",
  activeOwnerEpoch: 1,
  workerBundleHash: "a".repeat(64),
  workspaceBaseManifestRef: "manifest",
  remoteWorkspaceDir: "/workspace",
  ...fields,
});
function lineage(
  sessionKey: string,
  knownRows: Map<string, GatewaySessionRow>,
  request?: ReturnType<typeof vi.fn>,
) {
  return fetchSessionLineage({
    captureReconcile: () => vi.fn(),
    sessions: { describe: request ?? vi.fn() },
    client: request
      ? createTestGatewayClient(request)
      : ({} as Parameters<typeof fetchSessionLineage>[0]["client"]),
    sessionKey,
    knownRows,
    isCurrent: () => true,
  });
}
function attentionRequest(
  kind: "approval" | "question",
  id: string,
  preview: string,
  createdAtMs: number,
  count = 1,
) {
  return { kind, id, preview, count, createdAtMs };
}

it("does not manufacture personal pins from plugin defaults", () => {
  const pluginNavigation = [
    { id: "boards", label: "Boards", page: { id: "boards" } },
    { id: "child", parent: "boards", label: "Child", page: { id: "child" } },
  ].map((value): ControlUiRegistration<ControlUiNavigationItem> => ({
    key: `example/${value.id}`,
    pluginId: "example",
    signal: new AbortController().signal,
    value,
    host: {} as ControlUiHost,
  }));
  const reconcile = (sidebarEntries: string[]) =>
    buildReconciledSidebarZone({
      sidebarEntries,
      pluginNavigation,
      pluginTabs: undefined,
      rows: [],
    });
  const initial = reconcile(["route:usage"]);
  expect(initial.sidebarEntries).toEqual(["route:usage"]);
  const pinned = ["plugin:example/child", ...initial.sidebarEntries];
  expect(reconcile(pinned).sidebarEntries).toEqual(pinned);
  expect(reconcile(pinned).entries[0]).toEqual({ type: "plugin", key: "example/child" });
});

it.each([
  ["global before hello", "global", undefined, "global"],
  ["global advertised without a roster", undefined, " GLOBAL ", "GLOBAL"],
  ["explicit per-sender scope", "per-sender", "global", "agent:ops:workspace"],
  ["per-agent key without a roster", undefined, "agent:other:legacy", "agent:ops:workspace"],
] as const)(
  "preserves the sidebar main destination for %s",
  (_name, scope, advertised, expected) => {
    expect(
      resolveSidebarMainSessionKey({
        agentId: "ops",
        agentsList: scope
          ? { defaultId: "main", mainKey: "workspace", scope, agents: [] }
          : undefined,
        hello: advertised
          ? {
              ...gatewayHelloForMethods([]),
              snapshot: {
                sessionDefaults: {
                  defaultAgentId: "main",
                  mainKey: "workspace",
                  mainSessionKey: advertised,
                },
              },
            }
          : null,
      }),
    ).toBe(expected);
  },
);

it.each([
  ["agent:main:dashboard:incognito-session", undefined, true],
  ["agent:main:subagent:incognito-child", undefined, true],
  ["agent:main:internal-session-effects:incognito-effect", undefined, true],
  ["agent:main:dashboard:ordinary", true, true],
  ["agent:main:dashboard:ordinary", undefined, false],
  ["agent:main:telegram:incognito-peer", undefined, false],
] as const)("preserves Incognito sidebar presentation for %s", (key, incognito, expected) => {
  expect(projectSidebarSession({ key, incognito }).incognito).toBe(expected);
});

type SortMode = "created" | "updated" | "people";
function sortSidebarRows(
  rows: GatewaySessionRow[],
  sortMode: SortMode,
  owners?: SessionsListResult["owners"],
) {
  return rows.toSorted(
    createSidebarSessionRowsComparator(() => ({
      sortMode,
      createdOrder: new Map(rows.map((row, index) => [row.key, index])),
      owners,
    })),
  );
}

describe("sidebar session sort modes", () => {
  const row = (
    key: string,
    createdAt?: number,
    updatedAt = 1,
    ownerId?: string,
  ): GatewaySessionRow => ({
    key,
    kind: "direct",
    updatedAt,
    createdAt,
    createdActor: ownerId ? { type: "human", id: ownerId } : undefined,
    owner: ownerId ? { actor: { type: "human", id: ownerId } } : undefined,
  });

  it.each<[SortMode, GatewaySessionRow[], string[], SessionsListResult["owners"]]>([
    [
      "created",
      [row("old-stamped", 100), row("legacy"), row("new-stamped", 200), row("invalid", Number.NaN)],
      ["new-stamped", "old-stamped", "legacy", "invalid"],
      undefined,
    ],
    [
      "people",
      [
        row("alex-old", 100, 1, "alex"),
        row("sam-new", 300, 1, "sam"),
        row("alex-new", 200, 1, "alex"),
      ],
      ["alex-new", "alex-old", "sam-new"],
      [
        { type: "human", id: "alex", label: "Alex" },
        { type: "human", id: "sam", label: "Sam" },
      ],
    ],
    [
      "updated",
      [row("created-new", 300, 100), row("updated-new", 100, 300)],
      ["updated-new", "created-new"],
      undefined,
    ],
  ])("orders %s by its primary and secondary keys", (mode, rows, expected, owners) => {
    expect(sortSidebarRows(rows, mode, owners).map((entry) => entry.key)).toEqual(expected);
  });

  it("keeps first-facet precedence and row label fallbacks across People projections", () => {
    const alex = row("alex", 100, 1, " alex ");
    const sam = row("sam", 100, 1, "sam");
    alex.owner!.actor.label = "Alex";
    sam.owner!.actor.label = "Sam";
    const rows = [sam, alex];
    const owners: NonNullable<SessionsListResult["owners"]> = [
      { type: "human", id: "alex", label: " " },
      { type: "human", id: "alex", label: "Zed" },
      { type: "human", id: "sam", label: "Sam" },
    ];
    expect(sortSidebarRows(rows, "people", owners)).toEqual([alex, sam]);
    owners[0] = { type: "human", id: "alex", label: "Zed" };
    expect(sortSidebarRows(rows, "people", owners)).toEqual([sam, alex]);
  });
});

const worktree = { id: "wt-1", branch: "feature/ui", repoRoot: "/repo" };
it.each<[Partial<GatewaySessionRow>, string]>([
  [{ worktree }, "worktree"],
  [{ worktree, execNode: "build-node", execCwd: "/remote/task" }, "worktree"],
  [
    { repository: { url: "https://github.com/example/project.git", branch: "feature/ui" } },
    "checkout",
  ],
])("labels workspace %j only from recorded repository facts", (row, expected) => {
  expect(projectSidebarSession(row)).toMatchObject({ workspaceKind: expected, workSession: true });
});

it("carries active cloud identity, machine facts, and disk pressure into the sidebar", () => {
  expect(
    projectSidebarSession({
      placement: placement({
        providerId: "machine0",
        profileId: "team",
        machine: { class: "medium", os: "linux", cpu: 4, memoryGb: 16 },
        diskSpace: {
          status: "critical",
          availableBytes: 50,
          totalBytes: 1_000,
          observedAtMs: 25,
        },
      }),
    }),
  ).toMatchObject({
    placementState: "active",
    placementProviderId: "machine0",
    placementProfileId: "team",
    placementMachine: { class: "medium", os: "linux", cpu: 4, memoryGb: 16 },
    diskSpaceStatus: "critical",
  });
});

it("distinguishes an admin's own draft from another person's draft", () => {
  const ownDraft = {
    visibility: "draft" as const,
    sharingRole: "admin" as const,
    createdActor: { type: "human" as const, id: "admin" },
  };
  expect(projectSidebarSession(ownDraft, "admin").draftOwnedBySelf).toBe(true);
  expect(projectSidebarSession(ownDraft, "teammate").draftOwnedBySelf).toBe(false);
});

describe("sidebar navigation lineage ownership", () => {
  const childKey = "agent:main:dashboard:child";
  const navigationParent = direct("agent:main:dashboard:navigation-parent", {
    childSessions: [childKey],
  });
  const controlParent = direct("agent:main:main", { childSessions: [childKey] });
  const child = direct(childKey, {
    parentSessionKey: navigationParent.key,
    spawnedBy: controlParent.key,
  });

  it.each([
    { name: "main alias", rootKey: "main", cachedKey: "agent:main:main" },
    {
      name: "case-preserving Matrix alias",
      rootKey: "Agent:Ops:Matrix:Channel:!Room:Example.Org",
      cachedKey: "agent:ops:matrix:channel:!Room:Example.Org",
    },
  ])(
    "keeps the canonical root authoritative over an $name cached child key",
    async ({ rootKey, cachedKey }) => {
      const row = (key: string, status: "available" | "offline"): GatewaySessionRow => ({
        ...child,
        key,
        placement: placement({ runner: { kind: "device", status } }),
      });
      const canonical = {
        ...row(rootKey, "offline"),
        parentSessionKey: undefined,
        spawnedBy: undefined,
      };
      const cached = row(cachedKey, "available");
      const hidden = row("agent:main:subagent:hidden", "available");

      const known = collectKnownSessionRows([canonical], {
        [navigationParent.key]: [cached, hidden],
      });

      expect(known.get(canonical.key)).toBe(canonical);
      expect(known.get(hidden.key)).toBe(hidden);
      expect(known).toHaveLength(2);
      const request = vi.fn();
      const result = await lineage(cached.key, known, request);
      expect(result?.topmostRow).toBe(canonical);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("keeps case-sensitive Matrix and Signal session identifiers distinct", () => {
    const keys = [
      "agent:ops:matrix:channel:!Room:Example.Org",
      "agent:ops:matrix:channel:!room:example.org",
      "agent:ops:signal:group:AbC123=",
      "agent:ops:signal:group:abc123=",
    ];
    const rows = keys.map((key) => ({ ...child, key }));

    expect([...collectKnownSessionRows(rows, {}).keys()]).toEqual(keys);
  });

  it("keeps exact-key insertion order while newer rows replace cached child values", () => {
    const parent = direct("agent:main:parent", { updatedAt: 1 });
    const first = direct("agent:main:child", { spawnedBy: parent.key, label: "Old child" });
    const caseVariant = { ...first, key: "agent:main:Child", label: "Distinct child" };
    const sibling = { ...first, key: "agent:main:sibling", label: "Sibling" };
    const current = { ...first, label: "Current child", hasActiveRun: true };
    const rowsByKey = collectSidebarSessionRowsByKey({
      rows: [parent, current],
      childRowsByParent: {
        firstCache: [first, caseVariant],
        secondCache: [{ ...first, label: "Later cached child" }, sibling],
      },
    });
    const [tree] = projectTree([parent], [], { rowsByKey });

    expect(tree?.children.map((row) => [row.key, row.label, row.hasActiveRun])).toEqual([
      [first.key, "Current child", true],
      [caseVariant.key, "Distinct child", false],
      [sibling.key, "Sibling", false],
    ]);
    expect(tree?.runningChildCount).toBe(1);
  });

  it("promotes an explicitly categorized dashboard child to a sidebar section root", () => {
    const categorizedChild = {
      ...child,
      key: "agent:main:dashboard:child",
      category: "P1 issues from beta feedback",
    };
    const roots = [navigationParent, categorizedChild];
    const projected = projectTree(roots, roots);

    expect(
      projected.map((row) => [
        row.key,
        row.category,
        row.isChild,
        row.children.map((entry) => entry.key),
      ]),
    ).toEqual([
      [navigationParent.key, undefined, false, []],
      [categorizedChild.key, categorizedChild.category, false, []],
    ]);
  });

  it("counts normalized live runs for an archived subagent", () => {
    const childRow = {
      ...child,
      status: "running" as const,
      hasActiveRun: true,
      hasActiveSubagentRun: true,
      archived: true,
    };
    const [projected] = projectTree([navigationParent], [navigationParent, childRow]);
    expect(projected).toMatchObject({ runningChildCount: 0, failedChildCount: 0 });
  });

  it("preserves transitive summaries with unloaded children", () => {
    const root = direct("root", { childSessions: ["first", "second", "missing"] });
    const rows: GatewaySessionRow[] = [
      root,
      direct("first", { status: "failed", childSessions: ["grandchild"] }),
      direct("second", { status: "timeout" }),
      direct("grandchild", { status: "running", hasActiveRun: true }),
    ];
    const attention: Record<string, SidebarSessionAttention> = {
      first: {
        kind: "question",
        requests: [attentionRequest("question", "first", "Continue?", 2)],
      },
      second: {
        kind: "approval",
        requests: [attentionRequest("approval", "second", "Approve?", 3)],
      },
    };
    const conflicts: Record<string, number> = {
      root: 1,
      first: 4_503_599_627_370_496,
      second: 0.5,
    };
    const trees = projectTree([root], rows, {
      resolveAttention: ({ key }) =>
        key === "missing"
          ? { kind: "approval", requests: [attentionRequest("approval", "missing", "Approve?", 1)] }
          : { kind: "none" },
      toSidebarSession: (row, isChild) => ({
        ...projectSidebarSession(row),
        isChild: isChild === true,
        visuallyActive: row.key === "grandchild",
        attention: attention[row.key] ?? { kind: "none" },
        workspaceConflictCount: conflicts[row.key],
      }),
    });
    expect(trees[0]).toMatchObject({
      attention: { kind: "approval" },
      runningChildCount: 1,
      failedChildCount: 2,
      containsActiveDescendant: true,
      workspaceConflictCount: 4_503_599_627_370_497,
    });
    expect(trees[0]?.childSessionKeys).toStrictEqual(["first", "second", "missing"]);
    expect(
      trees[0]?.children.map((row) => [row.key, row.runningChildCount, row.failedChildCount]),
    ).toStrictEqual([
      ["first", 1, 0],
      ["second", 0, 0],
    ]);
  });

  it("counts repeated requests once across depths while expanded rows keep their own attention", () => {
    const shared = attentionRequest("approval", "shared", "Review deployment", 1);
    const question = attentionRequest("question", "question", "Choose a region", 2, 2);
    const later = attentionRequest("approval", "later", "Confirm rollout", 3);
    const root = direct("root", { childSessions: ["child"] });
    const rows: GatewaySessionRow[] = [
      root,
      direct("child", {
        status: "queued",
        hasActiveRun: true,
        childSessions: ["grandchild"],
      }),
      direct("grandchild", { status: "failed" }),
    ];
    const attention: Record<string, SidebarSessionAttention> = {
      root: { kind: "approval", requests: [shared] },
      child: { kind: "question", requests: [question] },
      grandchild: { kind: "approval", requests: [shared, later] },
    };
    const [tree] = projectTree([root], rows, {
      toSidebarSession: (row, isChild) => ({
        ...projectSidebarSession(row),
        isChild: isChild === true,
        attention: attention[row.key]!,
      }),
    });
    expect(tree).toMatchObject({
      ownAttention: attention.root,
      runningChildCount: 1,
      queuedChildCount: 1,
      failedChildCount: 1,
      attention: { kind: "approval", requests: [shared, question, later] },
    });
    const container = document.createElement("div");
    for (const [row, includeChildren, label] of [
      [tree!, true, "2 requests need approval\nReview deployment\n+1 more"],
      [tree!, false, "Waiting for approval\nReview deployment"],
      [tree!.children[0]!, false, "2 questions need your answer\nChoose a region\n+1 more"],
    ] as const) {
      const view = mountSolid(
        () =>
          createComponent(TeamSessionSlots, {
            rows: [row],
            includeChildren,
            childCount: row.childSessionKeys.length,
          }),
        { container },
      );
      expect(container.querySelector("[data-session-attention]")?.getAttribute("aria-label")).toBe(
        label,
      );
      view.unmount();
    }
  });

  it.each([
    ["navigation parent", child, navigationParent, [navigationParent, controlParent, child]],
    ["controller for blank lineage", { ...child, parentSessionKey: "  \t  " }, controlParent, null],
  ] as const)("walks a directly opened child through its %s", async (_name, row, parent, known) => {
    const rows = known ?? [parent, row];
    expect(projectTree([parent], [...rows])[0]?.children.map((entry) => entry.key)).toEqual([
      row.key,
    ]);
    expect(await lineage(row.key, new Map(rows.map((entry) => [entry.key, entry])))).toMatchObject({
      rowsByParent: { [parent.key]: [row] },
      topmostRow: parent,
      lookupFailed: false,
    });
  });
});

it("keeps a prepared worktree session in Coding before canonical metadata arrives", () => {
  const key = "agent:main:new-worktree";
  const context = {
    basePath: "",
    agents: { state: { agentsList: { mainKey: "main" } } },
    agentSelection: { state: { selectedId: "main" } },
    gateway: { snapshot: { assistantAgentId: "main", hello: null } },
    sessions: {
      isPreparedWorkSession: (candidate: string) => candidate === key,
      pullRequestSummary: () => undefined,
      isRunVisuallyActive: () => false,
    },
  } as unknown as Parameters<typeof buildSidebarSessionNavigationState>[0]["context"];
  const navigation = buildSidebarSessionNavigationState({
    context,
    routeSessionKey: key,
    sessionsResult: {
      ts: 1,
      path: "(multiple)",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [{ key, kind: "direct", updatedAt: 1 }],
    },
    sessionsAgentId: null,
    showCron: false,
    showSystem: false,
    statusFilter: "active",
    compareSessions: () => 0,
    highlightCurrentSession: true,
    runtimeSampledAtByRow: new WeakMap(),
    loadingChildSessionKeys: new Set(),
    outboxAttentionCountForSessionKey: () => 0,
    hasSessionDraft: () => false,
    resolveAttention: () => ({ kind: "none" }),
    resolveAgentStatusNote: () => undefined,
  });

  expect(navigation.visibleSessionRows).toHaveLength(1);
  expect(navigation.toSidebarSession(navigation.visibleSessionRows[0]!).workSession).toBe(true);
});
