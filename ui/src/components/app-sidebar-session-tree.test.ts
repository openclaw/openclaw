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
    runningChildCount: 0,
    failedChildCount: 0,
  } as SidebarRecentSession;
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
    const options = {
      roots: rows,
      rowsByKey: new Map(rows.map((row) => [row.key, row])),
      loadingChildKeys: new Set<string>(),
      resolveAttention: () => SIDEBAR_SESSION_NO_ATTENTION,
      toSidebarSession: present,
    };
    const tree = projectSessionTree(options);
    expect(tree.map((row) => row.key)).toEqual([homeKey]);
    expect(tree[0]?.children.map((row) => row.key)).toEqual([conversationKey]);
    expect(tree.flatMap((row) => [row, ...row.children])).toHaveLength(2);
    expect(tree[0]).toMatchObject({
      childSessionKeys: [conversationKey],
      containsActiveDescendant: true,
      runningChildCount: 2,
      unreadChildCount: 1,
      subagentSummary: { runningChildCount: 1, unreadChildCount: 0 },
    });
    expect(child.parentSessionKey).toBe(workerKey);

    const unloadedRun = projectSessionTree({
      ...options,
      roots: [parent, child],
      rowsByKey: new Map([parent, child].map((row) => [row.key, row])),
    });
    expect(unloadedRun.map((row) => row.key)).toEqual([homeKey, conversationKey]);
    for (const archivedKey of [workerKey, homeKey]) {
      const archivedRows = [
        { ...parent, archived: archivedKey === homeKey },
        { ...run, archived: archivedKey === workerKey },
        child,
      ];
      const archivedAncestor = projectSessionTree({
        ...options,
        roots: archivedRows,
        rowsByKey: new Map(archivedRows.map((row) => [row.key, row])),
      });
      expect(archivedAncestor.map((row) => row.key)).toEqual([homeKey, conversationKey]);
    }

    const outer: GatewaySessionRow = {
      key: "agent:main:outer",
      kind: "direct",
      childSessions: [homeKey],
    };
    const nestedParent = { ...parent, spawnedBy: outer.key };
    const nestedTree = projectSessionTree({
      ...options,
      roots: [outer, child],
      rowsByKey: new Map([outer, nestedParent, run, child].map((row) => [row.key, row])),
    });
    expect(nestedTree.map((row) => row.key)).toEqual([outer.key]);
    expect(nestedTree[0]?.children[0]?.children.map((row) => row.key)).toEqual([conversationKey]);

    // The Gateway flag is transitive; visible child work must not ring twice.
    run.hasActiveRun = false;
    run.hasActiveSubagentRun = true;
    expect(projectSessionTree(options)[0]).toMatchObject({
      runningChildCount: 1,
      subagentSummary: { runningChildCount: 0 },
    });

    // Parent-owned lists can supply ancestry without a child's back-reference.
    delete run.spawnedBy;
    const listedTree = projectSessionTree(options);
    expect(listedTree.map((row) => row.key)).toEqual([homeKey]);
    expect(listedTree[0]?.children.map((row) => row.key)).toEqual([conversationKey]);

    // With no loaded persistent ancestor, retain the ordinary root candidate.
    const fallback = projectSessionTree({
      ...options,
      roots: [run, child],
      rowsByKey: new Map([run, child].map((row) => [row.key, row])),
    });
    expect(fallback.map((row) => row.key)).toEqual([conversationKey]);
    expect(fallback[0]?.isChild).toBe(false);
    run.spawnedBy = workerKey;
    expect(
      projectSessionTree({
        ...options,
        roots: [run, child],
        rowsByKey: new Map([run, child].map((row) => [row.key, row])),
      }).map((row) => row.key),
    ).toEqual([conversationKey]);
  });

  it.each(["running", "done"] as const)(
    "keeps independent conversations outside Home with a %s worker",
    (status) => {
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
        status,
      };
      const rows = [home, conversation, worker];
      const options = {
        roots: rows,
        rowsByKey: new Map(rows.map((row) => [row.key, row])),
        mainSessionKeys: new Set([homeKey]),
        loadingChildKeys: new Set<string>(),
        resolveAttention: () => SIDEBAR_SESSION_NO_ATTENTION,
        toSidebarSession: present,
      };
      const tree = projectSessionTree(options);

      expect(tree.map((row) => row.key)).toEqual([homeKey, conversationKey]);
      expect(tree[0]?.children).toEqual([]);
      expect(tree[1]?.isChild).toBe(false);
      expect(conversation.parentSessionKey).toBe(homeKey);
    },
  );

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
    const options = {
      roots: [home, child],
      rowsByKey: new Map<string, GatewaySessionRow>([
        [home.key, home],
        [child.key, child],
      ]),
      mainSessionKeys: new Set([homeKey]),
      loadingChildKeys: new Set<string>(),
      resolveAttention: () => SIDEBAR_SESSION_NO_ATTENTION,
      toSidebarSession: present,
    };
    const tree = projectSessionTree(options);
    expect(tree.map((row) => row.key)).toEqual([homeKey]);
    expect(tree[0]?.children.map((row) => row.key)).toEqual([child.key]);
  });
});
