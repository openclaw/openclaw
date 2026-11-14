import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { compareSessionRowsByUpdatedAt } from "../lib/sessions/navigation.ts";
import { runningRow } from "../test-helpers/app-sidebar-session-narration.ts";
import { projectSessionTree } from "./app-sidebar-session-tree.ts";
import {
  SIDEBAR_SESSION_NO_ATTENTION,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";

const homeKey = "agent:main:main";
const conversationKey = "agent:main:dashboard:conversation";
const workerKey = "agent:main:subagent:review";

function present(row: GatewaySessionRow, isChild = false): SidebarRecentSession {
  return {
    ...runningRow(row.key),
    label: row.label ?? row.key,
    isChild,
    hasActiveRun: row.hasActiveRun === true,
    backgroundProcessCount: row.backgroundProcessCount,
    active: row.key === conversationKey,
    unread: row.unread === true,
    status: row.status,
  };
}

function makeRow(key: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key, kind: "direct", ...fields };
}

function project(
  roots: GatewaySessionRow[],
  rows = roots,
  compareSessions?: (a: GatewaySessionRow, b: GatewaySessionRow) => number,
) {
  return projectSessionTree({
    roots,
    rowsByKey: new Map(rows.map((row) => [row.key, row])),
    mainSessionKeys: new Set([homeKey]),
    loadingChildKeys: new Set<string>(),
    compareSessions,
    resolveAttention: () => SIDEBAR_SESSION_NO_ATTENTION,
    toSidebarSession: present,
  });
}

it("reattaches a persistent session through hidden runs and reveals its visible ancestor", () => {
  const parent = makeRow(homeKey, { childSessions: [workerKey] });
  const run = makeRow(workerKey, {
    spawnedBy: homeKey,
    childSessions: [conversationKey],
    hasActiveRun: true,
  });
  const child = makeRow(conversationKey, {
    parentSessionKey: workerKey,
    spawnedBy: workerKey,
    hasActiveRun: true,
    unread: true,
  });
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

  expect(project([parent, child]).map((row) => row.key)).toEqual([homeKey, conversationKey]);
  for (const archivedKey of [workerKey, homeKey]) {
    const archivedRows = [
      { ...parent, archived: archivedKey === homeKey },
      { ...run, archived: archivedKey === workerKey },
      child,
    ];
    expect(project(archivedRows).map((row) => row.key)).toEqual([homeKey, conversationKey]);
  }

  const outer = makeRow("agent:main:outer", { childSessions: [homeKey] });
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
  expect(fallback).toMatchObject([{ key: conversationKey, isChild: false }]);
  run.spawnedBy = workerKey;
  expect(project([run, child]).map((row) => row.key)).toEqual([conversationKey]);
});

it("counts background work once per descendant without marking its parent active", () => {
  const rows = [
    makeRow(homeKey),
    makeRow(workerKey, { spawnedBy: homeKey, backgroundProcessCount: 2 }),
    makeRow(conversationKey, {
      spawnedBy: workerKey,
      hasActiveRun: true,
      backgroundProcessCount: 1,
    }),
  ];
  expect(project(rows)[0]).toMatchObject({
    hasActiveRun: false,
    runningChildCount: 2,
    subagentSummary: { runningChildCount: 1 },
  });
});

it.each([false, true])(
  "folds hidden grandchild work through a persistent child (loaded: %s)",
  (loaded) => {
    const parent = makeRow(homeKey, {
      hasActiveRun: true,
      status: "queued",
      childSessions: [conversationKey],
    });
    const child = makeRow(conversationKey, {
      spawnedBy: homeKey,
      backgroundProcessCount: 2,
      hasActiveSubagentRun: true,
      childSessions: [workerKey],
    });
    const worker = makeRow(workerKey, { spawnedBy: conversationKey, hasActiveRun: true });
    const [tree] = project([parent], [parent, child, ...(loaded ? [worker] : [])]);
    expect(tree).toMatchObject({
      hasActiveRun: true,
      runningChildCount: 2,
      subagentSummary: { runningChildCount: 1 },
      children: [{ subagentSummary: { runningChildCount: 1 } }],
    });
    expect(project([parent], [parent, { ...child, hasActiveSubagentRun: false }])[0]).toMatchObject(
      {
        subagentSummary: { runningChildCount: 0 },
      },
    );
  },
);

it("keeps independent conversations outside Home while a worker runs", () => {
  const home = makeRow(homeKey, { childSessions: [conversationKey, workerKey] });
  const conversation = makeRow(conversationKey, {
    createdVia: "operator",
    spawnDepth: 0,
    parentSessionKey: homeKey,
  });
  const worker = makeRow(workerKey, {
    parentSessionKey: homeKey,
    spawnedBy: homeKey,
    spawnDepth: 1,
    status: "running",
  });
  const tree = project([home, conversation, worker]);
  expect(tree.map((row) => row.key)).toEqual([homeKey, conversationKey]);
  expect(tree[0]?.children).toEqual([]);
  expect(tree[1]?.isChild).toBe(false);
  expect(conversation.parentSessionKey).toBe(homeKey);
});

it("promotes a child without rewriting origin or moving its own descendants", () => {
  const parent = makeRow("parent", { childSessions: [conversationKey] });
  const child = makeRow(conversationKey, {
    parentSessionKey: parent.key,
    spawnedBy: parent.key,
    sidebarRoot: true,
    childSessions: ["grandchild"],
  });
  const grandchild = makeRow("grandchild", { parentSessionKey: child.key });
  const tree = project([parent, child, grandchild]);
  expect(tree.map((row) => row.key)).toEqual([parent.key, child.key]);
  expect(tree[0]?.childSessionKeys).toEqual([]);
  expect(tree[1]?.children.map((row) => row.key)).toEqual([grandchild.key]);
  expect(child).toMatchObject({ parentSessionKey: parent.key, spawnedBy: parent.key });
});

it("sorts each parent's children, including run-folded ones, with the root comparator", () => {
  const rows = [
    makeRow(homeKey),
    makeRow(conversationKey, { spawnedBy: homeKey, updatedAt: 20 }),
    makeRow(workerKey, { spawnedBy: homeKey }),
    makeRow("folded", { spawnedBy: workerKey, updatedAt: 30 }),
  ];
  const childIds = (tree: SidebarRecentSession[]) => tree[0]?.children.map((row) => row.key);

  expect(childIds(project([rows[0]!], rows))).toEqual([conversationKey, "folded"]);
  expect(childIds(project([rows[0]!], rows, compareSessionRowsByUpdatedAt))).toEqual([
    "folded",
    conversationKey,
  ]);
});
