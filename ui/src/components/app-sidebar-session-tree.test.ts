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
  const parentKey = "agent:main:dashboard:parent";
  const runKey = "agent:main:subagent:run";
  const child = (id: string, updatedAt: number, parent = parentKey) =>
    makeRow(`agent:main:dashboard:${id}`, { spawnedBy: parent, updatedAt });
  const rows: GatewaySessionRow[] = [
    makeRow(parentKey, { updatedAt: 1 }),
    child("1f0f", 20),
    child("4f1f", 10),
    makeRow(runKey, { spawnedBy: parentKey, updatedAt: 5 }),
    child("a392", 30, runKey),
    child("d517", 40),
  ];
  const childIds = (tree: SidebarRecentSession[]) =>
    tree[0]?.children.map((row) => row.key.replace("agent:main:dashboard:", ""));

  expect(childIds(project([rows[0]!], rows))).toEqual(["1f0f", "4f1f", "a392", "d517"]);
  expect(childIds(project([rows[0]!], rows, compareSessionRowsByUpdatedAt))).toEqual([
    "d517",
    "a392",
    "1f0f",
    "4f1f",
  ]);
});
