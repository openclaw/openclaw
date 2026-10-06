import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { projectSessionTree } from "./app-sidebar-session-tree.ts";
import {
  SIDEBAR_SESSION_NO_ATTENTION,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";

const homeKey = "agent:main:main";
const conversationKey = "agent:main:dashboard:conversation";
const workerKey = "agent:main:subagent:review";

// Only presentation fields consumed by the tree matter to these placement assertions.
function present(row: GatewaySessionRow, isChild = false): SidebarRecentSession {
  return {
    key: row.key,
    label: row.label ?? row.key,
    isChild,
    attention: { kind: "none" },
    hasActiveRun: row.hasActiveRun === true,
    active: row.key === conversationKey,
    unread: row.unread === true,
    status: row.status,
    runningChildCount: 0,
    failedChildCount: 0,
  } as SidebarRecentSession;
}

function project(roots: GatewaySessionRow[], rows = roots) {
  return projectSessionTree({
    roots,
    rowsByKey: new Map(rows.map((row) => [row.key, row])),
    mainSessionKeys: new Set([homeKey]),
    loadingChildKeys: new Set<string>(),
    resolveAttention: () => SIDEBAR_SESSION_NO_ATTENTION,
    toSidebarSession: present,
  });
}

describe("Home-linked conversation placement", () => {
  it("reattaches a persistent session through hidden runs and reveals its visible ancestor", () => {
    const parent: GatewaySessionRow = {
      key: homeKey,
      kind: "direct",
      childSessions: [workerKey],
    };
    const run: GatewaySessionRow = {
      key: workerKey,
      kind: "direct",
      spawnedBy: homeKey,
      childSessions: [conversationKey],
      hasActiveRun: true,
    };
    const child: GatewaySessionRow = {
      key: conversationKey,
      kind: "direct",
      parentSessionKey: workerKey,
      spawnedBy: workerKey,
      hasActiveRun: true,
      unread: true,
    };
    const rows = [parent, run, child];
    const tree = project(rows);
    expect(tree.map((row) => row.key)).toEqual([homeKey]);
    expect(tree[0]?.children.map((row) => row.key)).toEqual([conversationKey]);
    expect(tree[0]).toMatchObject({
      childSessionKeys: [conversationKey],
      containsActiveDescendant: true,
      runningChildCount: 2,
      unreadChildCount: 1,
      subagentSummary: { runningChildCount: 1, unreadChildCount: 0 },
    });
    expect(child.parentSessionKey).toBe(workerKey);

    const unloadedRun = project([parent, child]);
    expect(unloadedRun.map((row) => row.key)).toEqual([homeKey, conversationKey]);
    for (const archivedKey of [workerKey, homeKey]) {
      const archivedRows = [
        { ...parent, archived: archivedKey === homeKey },
        { ...run, archived: archivedKey === workerKey },
        child,
      ];
      const archivedAncestor = project(archivedRows);
      expect(archivedAncestor.map((row) => row.key)).toEqual([homeKey, conversationKey]);
    }

    const outer: GatewaySessionRow = {
      key: "agent:main:outer",
      kind: "direct",
      childSessions: [homeKey],
    };
    const nestedParent = { ...parent, spawnedBy: outer.key };
    const nestedTree = project([outer, child], [outer, nestedParent, run, child]);
    expect(nestedTree.map((row) => row.key)).toEqual([outer.key]);
    expect(nestedTree[0]?.children[0]?.children.map((row) => row.key)).toEqual([conversationKey]);

    // The Gateway flag is transitive; visible child work must not ring twice.
    run.hasActiveRun = false;
    run.hasActiveSubagentRun = true;
    expect(project(rows)[0]).toMatchObject({
      runningChildCount: 1,
      subagentSummary: { runningChildCount: 0 },
    });

    // Parent-owned lists can supply ancestry without a child's back-reference.
    delete run.spawnedBy;
    const listedTree = project(rows);
    expect(listedTree.map((row) => row.key)).toEqual([homeKey]);
    expect(listedTree[0]?.children.map((row) => row.key)).toEqual([conversationKey]);

    // With no loaded persistent ancestor, retain the ordinary root candidate.
    const fallback = project([run, child]);
    expect(fallback.map((row) => row.key)).toEqual([conversationKey]);
    expect(fallback[0]?.isChild).toBe(false);
    run.spawnedBy = workerKey;
    expect(project([run, child]).map((row) => row.key)).toEqual([conversationKey]);
  });

  it("keeps independent conversations outside Home while a worker runs", () => {
    const home: GatewaySessionRow = {
      key: homeKey,
      kind: "direct",
      childSessions: [conversationKey, workerKey],
    };
    const conversation: GatewaySessionRow = {
      key: conversationKey,
      kind: "direct",
      createdVia: "operator",
      spawnDepth: 0,
      parentSessionKey: homeKey,
    };
    const worker: GatewaySessionRow = {
      key: workerKey,
      kind: "direct",
      parentSessionKey: homeKey,
      spawnedBy: homeKey,
      spawnDepth: 1,
      status: "running",
    };
    const tree = project([home, conversation, worker]);
    expect(tree.map((row) => row.key)).toEqual([homeKey, conversationKey]);
    expect(tree[0]?.children).toEqual([]);
    expect(tree[1]?.isChild).toBe(false);
    expect(conversation.parentSessionKey).toBe(homeKey);
  });

  it.each([
    ["explicit suggested task", { parentSessionId: "home-generation" }],
    ["visible delegated session", { spawnDepth: 1 }],
    ["fork", { forkSource: { sessionKey: homeKey, sessionId: "home-generation" } }],
    ["retained fork marker", { forkedFromParent: true }],
    ["runtime-owned child", { spawnedBy: homeKey }],
    ["older ambiguous session", { createdVia: undefined, spawnDepth: undefined }],
  ] as const)("preserves the parent of an %s", (_name, metadata) => {
    const child = {
      key: conversationKey,
      kind: "direct",
      createdVia: "operator",
      spawnDepth: 0,
      parentSessionKey: homeKey,
      ...metadata,
    } satisfies GatewaySessionRow & { parentSessionId?: string };
    const home: GatewaySessionRow = {
      key: homeKey,
      kind: "direct",
      childSessions: [child.key],
    };
    const tree = project([home, child]);
    expect(tree.map((row) => row.key)).toEqual([homeKey]);
    expect(tree[0]?.children.map((row) => row.key)).toEqual([child.key]);
  });
});

describe("hidden run unread acknowledgement", () => {
  it("lists unread hidden runs on the parent that folds them, but not persistent children", () => {
    const nestedKey = "agent:main:subagent:nested";
    const failedKey = "agent:main:subagent:failed";
    const home: GatewaySessionRow = { key: homeKey, kind: "direct", unread: false };
    const rows: GatewaySessionRow[] = [
      home,
      { key: workerKey, kind: "direct", spawnedBy: homeKey, unread: true },
      { key: nestedKey, kind: "direct", spawnedBy: workerKey, unread: true },
      { key: failedKey, kind: "direct", spawnedBy: homeKey, unread: true, status: "failed" },
      { key: conversationKey, kind: "direct", spawnedBy: homeKey, unread: true },
    ];

    const [parent] = project([home], rows);

    expect(parent?.unreadChildCount).toBe(4);
    expect(parent?.subagentSummary?.unreadHiddenRuns?.map((row) => row.key)).toEqual([
      workerKey,
      nestedKey,
    ]);
    expect(parent?.unreadHiddenRuns).toBeUndefined();
    expect(parent?.children.map((row) => row.key)).toEqual([conversationKey]);
  });
});
