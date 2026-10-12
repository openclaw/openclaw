import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { ControlUiHost, ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { ControlUiRegistration } from "../plugins/control-ui-capability.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
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
import type { SidebarRecentSession, SidebarSessionAttention } from "./app-sidebar-session-types.ts";
import { renderTeamSessionSlots } from "./session-attention-presentation.ts";

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

function projectDraftOwnership(
  row: Pick<GatewaySessionRow, "createdActor" | "sharingRole" | "visibility">,
  selfUserId?: string,
): boolean | undefined {
  return projectSidebarSession(row, selfUserId).draftOwnedBySelf;
}

function sortSidebarRows(
  rows: GatewaySessionRow[],
  sortMode: "created" | "updated" | "people",
  createdOrder: ReadonlyMap<string, number>,
  owners?: SessionsListResult["owners"],
) {
  return rows.toSorted(
    createSidebarSessionRowsComparator(() => ({ sortMode, createdOrder, owners })),
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

  it("sorts timestamped sessions newest-first ahead of legacy sessions", () => {
    const rows = [
      row("old-stamped", 100),
      row("legacy"),
      row("new-stamped", 200),
      row("invalid", Number.NaN),
    ];
    const observed = new Map(rows.map((entry, index) => [entry.key, index]));

    expect(sortSidebarRows(rows, "created", observed).map((entry) => entry.key)).toEqual([
      "new-stamped",
      "old-stamped",
      "legacy",
      "invalid",
    ]);
  });

  it("keeps owner ordering primary and creation time secondary in People mode", () => {
    const rows = [
      row("alex-old", 100, 1, "alex"),
      row("sam-new", 300, 1, "sam"),
      row("alex-new", 200, 1, "alex"),
    ];
    const observed = new Map(rows.map((entry, index) => [entry.key, index]));

    expect(
      sortSidebarRows(rows, "people", observed, [
        { type: "human", id: "alex", label: "Alex" },
        { type: "human", id: "sam", label: "Sam" },
      ]).map((entry) => entry.key),
    ).toEqual(["alex-new", "alex-old", "sam-new"]);
  });

  it("leaves Updated mode ordered by activity", () => {
    const rows = [row("created-new", 300, 100), row("updated-new", 100, 300)];
    const observed = new Map(rows.map((entry, index) => [entry.key, index]));

    expect(sortSidebarRows(rows, "updated", observed).map((entry) => entry.key)).toEqual([
      "updated-new",
      "created-new",
    ]);
  });

  it("keeps first-facet precedence and row label fallbacks across People projections", () => {
    const alex = row("alex", 100, 1, " alex ");
    const sam = row("sam", 100, 1, "sam");
    alex.owner!.actor.label = "Alex";
    sam.owner!.actor.label = "Sam";
    const rows = [sam, alex];
    const observed = new Map(rows.map((entry, index) => [entry.key, index]));
    const owners: NonNullable<SessionsListResult["owners"]> = [
      { type: "human", id: "alex", label: " " },
      { type: "human", id: "alex", label: "Zed" },
      { type: "human", id: "sam", label: "Sam" },
    ];
    expect(sortSidebarRows(rows, "people", observed, owners)).toEqual([alex, sam]);
    owners[0] = { type: "human", id: "alex", label: "Zed" };
    expect(sortSidebarRows(rows, "people", observed, owners)).toEqual([sam, alex]);
  });
});

describe("sidebar workspace identity", () => {
  it.each([
    {
      name: "managed worktree",
      row: { worktree: { id: "wt-1", branch: "feature/ui", repoRoot: "/repo" } },
      expected: "worktree",
    },
    {
      name: "managed worktree on a node",
      row: {
        worktree: { id: "wt-1", branch: "feature/ui", repoRoot: "/repo" },
        execNode: "build-node",
        execCwd: "/remote/task",
      },
      expected: "worktree",
    },
    {
      name: "repository checkout",
      row: { repository: { url: "https://github.com/example/project.git", branch: "feature/ui" } },
      expected: "checkout",
    },
  ] satisfies { name: string; row: Partial<GatewaySessionRow>; expected: string | undefined }[])(
    "labels $name only from recorded repository facts",
    ({ row, expected }) => {
      const projected = projectSidebarSession(row);
      expect(projected.workspaceKind).toBe(expected);
      if (expected) {
        expect(projected.workSession).toBe(true);
      }
    },
  );
});

describe("sidebar session live-run projection", () => {
  it("carries active cloud identity, machine facts, and disk pressure into the sidebar", () => {
    const projected = projectSidebarSession({
      placement: {
        state: "active",
        environmentId: "environment-disk",
        providerId: "machine0",
        profileId: "team",
        machine: { class: "medium", os: "linux", cpu: 4, memoryGb: 16 },
        generation: 1,
        activeOwnerEpoch: 2,
        workspaceBaseManifestRef: "manifest-disk",
        remoteWorkspaceDir: "/workspace/disk",
        workerBundleHash: "a".repeat(64),
        createdAtMs: 10,
        updatedAtMs: 20,
        stateChangedAtMs: 15,
        diskSpace: {
          status: "critical",
          availableBytes: 50,
          totalBytes: 1_000,
          observedAtMs: 25,
        },
      },
    });

    expect(projected).toMatchObject({
      placementState: "active",
      placementProviderId: "machine0",
      placementProfileId: "team",
      placementMachine: { class: "medium", os: "linux", cpu: 4, memoryGb: 16 },
      diskSpaceStatus: "critical",
    });
  });
});

describe("sidebar draft ownership presentation", () => {
  it("distinguishes an admin's own draft from another person's draft", () => {
    const ownDraft = {
      visibility: "draft" as const,
      sharingRole: "admin" as const,
      createdActor: { type: "human" as const, id: "admin" },
    };
    expect(projectDraftOwnership(ownDraft, "admin")).toBe(true);
    expect(projectDraftOwnership(ownDraft, "teammate")).toBe(false);
  });
});

describe("sidebar navigation lineage ownership", () => {
  const navigationParent: GatewaySessionRow = {
    key: "agent:main:dashboard:navigation-parent",
    kind: "direct",
    updatedAt: 1,
    childSessions: ["agent:main:dashboard:child"],
  };
  const controlParent: GatewaySessionRow = {
    key: "agent:main:main",
    kind: "direct",
    updatedAt: 2,
    childSessions: ["agent:main:dashboard:child"],
  };
  const child: GatewaySessionRow = {
    key: "agent:main:dashboard:child",
    kind: "direct",
    updatedAt: 3,
    parentSessionKey: navigationParent.key,
    spawnedBy: controlParent.key,
  };

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
        placement: {
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
          runner: { kind: "device", status },
        },
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
      const lineage = await fetchSessionLineage({
        captureReconcile: () => vi.fn(),
        sessions: { describe: request },
        client: createTestGatewayClient(request),
        sessionKey: cached.key,
        knownRows: known,
        isCurrent: () => true,
      });
      expect(lineage?.topmostRow).toBe(canonical);
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
    const parent: GatewaySessionRow = {
      key: "agent:main:parent",
      kind: "direct",
      updatedAt: 1,
    };
    const first: GatewaySessionRow = {
      key: "agent:main:child",
      kind: "direct",
      spawnedBy: parent.key,
      label: "Old child",
    };
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
    const [tree] = projectSessionTree({
      roots: [parent],
      rowsByKey,
      loadingChildKeys: new Set(),
      resolveAttention: () => ({ kind: "none" }),
      toSidebarSession: (row, isChild) => ({
        ...projectSidebarSession(row),
        isChild: isChild === true,
      }),
    });

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
    const projected = projectSessionTree({
      roots: [navigationParent, categorizedChild],
      rowsByKey: collectSidebarSessionRowsByKey({
        rows: [navigationParent, categorizedChild],
        childRowsByParent: {},
      }),
      loadingChildKeys: new Set(),
      resolveAttention: () => ({ kind: "none" }),
      toSidebarSession: (row, isChild) =>
        ({
          key: row.key,
          category: row.category,
          isChild,
          attention: { kind: "none" },
          runningChildCount: 0,
          failedChildCount: 0,
        }) as SidebarRecentSession,
    });

    expect(
      projected.map((row) => ({
        key: row.key,
        category: row.category,
        isChild: row.isChild,
        children: row.children.map((entry) => entry.key),
      })),
    ).toEqual([
      { key: navigationParent.key, category: undefined, isChild: false, children: [] },
      {
        key: categorizedChild.key,
        category: categorizedChild.category,
        isChild: false,
        children: [],
      },
    ]);
  });

  it.each([
    [
      "archived subagent",
      { status: "running", hasActiveRun: true, hasActiveSubagentRun: true, archived: true },
      0,
      0,
    ],
  ] as const)(
    "counts normalized live runs for a %s",
    (_name, runState, runningChildCount, failedChildCount) => {
      const childRow = { ...child, ...runState };
      const projected = projectSessionTree({
        roots: [navigationParent],
        rowsByKey: collectSidebarSessionRowsByKey({
          rows: [navigationParent, childRow],
          childRowsByParent: {},
        }),
        loadingChildKeys: new Set(),
        resolveAttention: () => ({ kind: "none" }),
        toSidebarSession: (row, isChild) => ({
          ...projectSidebarSession(row),
          isChild: isChild === true,
        }),
      });

      expect(projected[0]).toMatchObject({ runningChildCount, failedChildCount });
    },
  );

  it.each([
    ["unloaded before children", "none", true, "approval", 1, 4_503_599_627_370_497],
  ] as const)(
    "preserves transitive summaries with %s",
    (_name, own, known, expected, conflicts, expectedConflicts) => {
      const root = {
        key: "root",
        kind: "direct",
        childSessions: ["first", "second", "missing"],
      } satisfies GatewaySessionRow;
      const rows: GatewaySessionRow[] = [
        root,
        { key: "first", kind: "direct", status: "failed", childSessions: ["grandchild"] },
        { key: "second", kind: "direct", status: "timeout" },
        { key: "grandchild", kind: "direct", status: "running", hasActiveRun: true },
      ];
      const trees = projectSessionTree({
        roots: [root],
        rowsByKey: collectSidebarSessionRowsByKey({ rows, childRowsByParent: {} }),
        loadingChildKeys: new Set(),
        resolveAttention: ({ key }) =>
          known && key === "missing"
            ? {
                kind: "approval",
                requests: [
                  {
                    kind: "approval",
                    id: "missing",
                    preview: "Approve?",
                    count: 1,
                    createdAtMs: 1,
                  },
                ],
              }
            : { kind: "none" },
        toSidebarSession: (row, isChild) => ({
          ...projectSidebarSession(row),
          isChild: isChild === true,
          visuallyActive: row.key === "grandchild",
          attention:
            row.key === "root"
              ? { kind: own }
              : row.key === "first"
                ? {
                    kind: "question",
                    requests: [
                      {
                        kind: "question",
                        id: "first",
                        preview: "Continue?",
                        count: 1,
                        createdAtMs: 2,
                      },
                    ],
                  }
                : row.key === "second"
                  ? {
                      kind: "approval",
                      requests: [
                        {
                          kind: "approval",
                          id: "second",
                          preview: "Approve?",
                          count: 1,
                          createdAtMs: 3,
                        },
                      ],
                    }
                  : { kind: "none" },
          workspaceConflictCount:
            row.key === "root"
              ? conflicts
              : row.key === "first"
                ? 4_503_599_627_370_496
                : row.key === "second"
                  ? 0.5
                  : undefined,
        }),
      });
      expect(trees[0]).toMatchObject({
        attention: { kind: expected },
        runningChildCount: 1,
        failedChildCount: 2,
        containsActiveDescendant: true,
        workspaceConflictCount: expectedConflicts,
      });
      expect(trees[0]?.childSessionKeys).toStrictEqual(["first", "second", "missing"]);
      expect(
        trees[0]?.children.map((row) => [row.key, row.runningChildCount, row.failedChildCount]),
      ).toStrictEqual([
        ["first", 1, 0],
        ["second", 0, 0],
      ]);
    },
  );

  it("counts repeated requests once across depths while expanded rows keep their own attention", () => {
    const shared = {
      kind: "approval",
      id: "shared",
      preview: "Review deployment",
      count: 1,
      createdAtMs: 1,
    } as const;
    const question = {
      kind: "question",
      id: "question",
      preview: "Choose a region",
      count: 2,
      createdAtMs: 2,
    } as const;
    const later = {
      kind: "approval",
      id: "later",
      preview: "Confirm rollout",
      count: 1,
      createdAtMs: 3,
    } as const;
    const root = {
      key: "root",
      kind: "direct",
      childSessions: ["child"],
    } satisfies GatewaySessionRow;
    const rows: GatewaySessionRow[] = [
      root,
      {
        key: "child",
        kind: "direct",
        status: "queued",
        hasActiveRun: true,
        childSessions: ["grandchild"],
      },
      { key: "grandchild", kind: "direct", status: "failed" },
    ];
    const attention: Record<string, SidebarSessionAttention> = {
      root: { kind: "approval", requests: [shared] },
      child: { kind: "question", requests: [question] },
      grandchild: { kind: "approval", requests: [shared, later] },
    };
    const [tree] = projectSessionTree({
      roots: [root],
      rowsByKey: new Map(rows.map((row) => [row.key, row])),
      loadingChildKeys: new Set(),
      resolveAttention: () => ({ kind: "none" }),
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
      render(
        renderTeamSessionSlots([row], includeChildren, row.childSessionKeys.length),
        container,
      );
      expect(container.querySelector("[data-session-attention]")?.getAttribute("aria-label")).toBe(
        label,
      );
    }
  });

  it("walks a directly opened child through its navigation parent, not its controller", async () => {
    const knownRows = new Map(
      [navigationParent, controlParent, child].map((row) => [row.key, row]),
    );
    const lineage = await fetchSessionLineage({
      captureReconcile: () => vi.fn(),
      sessions: { describe: vi.fn() },
      client: {} as Parameters<typeof fetchSessionLineage>[0]["client"],
      sessionKey: child.key,
      knownRows,
      isCurrent: () => true,
    });

    expect(lineage).toMatchObject({
      rowsByParent: { [navigationParent.key]: [child] },
      topmostRow: navigationParent,
      lookupFailed: false,
    });
  });

  it("falls back to the control owner when persisted navigation lineage is blank", async () => {
    const childWithBlankParent = { ...child, parentSessionKey: "  \t  " };
    const projected = projectSessionTree({
      roots: [controlParent],
      rowsByKey: collectSidebarSessionRowsByKey({
        rows: [controlParent, childWithBlankParent],
        childRowsByParent: {},
      }),
      loadingChildKeys: new Set(),
      resolveAttention: () => ({ kind: "none" }),
      toSidebarSession: (row, isChild) =>
        ({
          key: row.key,
          isChild,
          attention: { kind: "none" },
          runningChildCount: 0,
          failedChildCount: 0,
        }) as SidebarRecentSession,
    });

    expect(projected[0]?.children.map((row) => row.key)).toEqual([child.key]);

    const lineage = await fetchSessionLineage({
      captureReconcile: () => vi.fn(),
      sessions: { describe: vi.fn() },
      client: {} as Parameters<typeof fetchSessionLineage>[0]["client"],
      sessionKey: child.key,
      knownRows: new Map([controlParent, childWithBlankParent].map((row) => [row.key, row])),
      isCurrent: () => true,
    });

    expect(lineage).toMatchObject({
      rowsByParent: { [controlParent.key]: [childWithBlankParent] },
      topmostRow: controlParent,
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
