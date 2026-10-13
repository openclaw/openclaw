import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type FixtureNode = {
  id: number;
  name: string;
  size: number;
  edges: Array<[type: number, target: number, name?: string]>;
};

function fixture(grown: boolean) {
  const growthEdges: FixtureNode["edges"] = grown ? [[0, 8]] : [];
  const growthNodes: FixtureNode[] = grown
    ? [
        { id: 17, name: "Cache 🦞", size: 5, edges: [[0, 9]] },
        { id: 19, name: "Payload", size: 20, edges: [] },
      ]
    : [];
  const nodes: FixtureNode[] = [
    {
      id: 1,
      name: "root",
      size: 0,
      edges: [[0, 1, "cache"], [0, 2], [1, 7], [2, 4, "shortcut"], ...growthEdges],
    },
    {
      id: 3,
      name: "Cache 🦞",
      size: 10,
      edges: [
        [0, 3, "nested"],
        [0, 5, "shared"],
      ],
    },
    { id: 5, name: "Cache 🦞", size: 20, edges: [[0, 5]] },
    { id: 7, name: "Cache 🦞", size: 5, edges: [[0, 4, "payload"]] },
    { id: 9, name: "Payload", size: grown ? 90 : 40, edges: [[0, 3]] },
    { id: 11, name: "Shared", size: grown ? 70 : 30, edges: [] },
    { id: 13, name: "Detached", size: 1_000, edges: [[0, 1]] },
    { id: 15, name: "WeakOnly", size: 2_000, edges: [] },
    ...growthNodes,
  ];
  // An unused string crosses the streaming reader's chunk boundary without becoming a class label.
  return snapshot(nodes, "x".repeat(1024 * 1024));
}

function snapshot(nodes: FixtureNode[], unusedString = "") {
  const strings = [
    unusedString,
    ...new Set([
      ...nodes.map((node) => node.name),
      ...nodes.flatMap((node) => node.edges.map((edge) => edge[2] ?? "ref")),
    ]),
  ];
  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: ["type", "name", "id", "self_size", "edge_count"],
        node_types: [["object"], "string", "number", "number", "number"],
        edge_fields: ["type", "name_or_index", "to_node"],
        edge_types: [["property", "weak", "shortcut"], "string_or_number", "node"],
      },
      node_count: nodes.length,
      edge_count: nodes.reduce((sum, node) => sum + node.edges.length, 0),
    },
    nodes: nodes.flatMap((node) => [
      0,
      strings.indexOf(node.name),
      node.id,
      node.size,
      node.edges.length,
    ]),
    edges: nodes.flatMap((node) =>
      node.edges.flatMap(([type, target, name]) => [
        type,
        strings.indexOf(name ?? "ref"),
        target * 5,
      ]),
    ),
    strings,
  });
}

function runDiff(beforeSnapshot: string, afterSnapshot: string, args: string[]) {
  const directory = tempDirs.make("heap-snapshot-diff-");
  const before = path.join(directory, "before.heapsnapshot");
  const after = path.join(directory, "after.heapsnapshot");
  writeFileSync(before, beforeSnapshot);
  writeFileSync(after, afterSnapshot);
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["scripts/heap-snapshot-diff.mjs", before, after, "--json", ...args],
      { encoding: "utf8" },
    ),
  );
}

it("diffs exclusive retained sizes and named strong paths without double-counting shared or nested objects", () => {
  const result = runDiff(fixture(false), fixture(true), ["--max-depth", "3", "--node", "15"]);

  expect(result.before).toEqual({ nodes: 8, reachable: 6 });
  expect(result.after).toEqual({ nodes: 10, reachable: 8 });
  expect(result.classes).toEqual(
    expect.arrayContaining([
      {
        label: "object: Cache 🦞",
        before: 75,
        after: 150,
        delta: 75,
        countDelta: 1,
        shallowDelta: 5,
      },
      {
        label: "object: Shared",
        before: 30,
        after: 70,
        delta: 40,
        countDelta: 0,
        shallowDelta: 40,
      },
    ]),
  );
  expect(result.dominators).toEqual(
    expect.arrayContaining([
      { id: 1, label: "object: root", before: 105, after: 220, delta: 115 },
      { id: 3, label: "object: Cache 🦞", before: 55, after: 105, delta: 50 },
      { id: 7, label: "object: Cache 🦞", before: 45, after: 95, delta: 50 },
      { id: 17, label: "object: Cache 🦞", before: 0, after: 25, delta: 25 },
    ]),
  );
  expect(
    result.classes.some((row: { label: string }) => /Detached|WeakOnly/u.test(row.label)),
  ).toBe(false);
  const payload = result.retainers.find((row: { id: number }) => row.id === 9);
  expect(payload.rootPath).toEqual({
    depth: 3,
    omittedAncestors: 1,
    nodes: [
      {
        id: 3,
        label: "object: Cache 🦞",
        retained: 105,
        incomingEdge: { type: "property", name: "cache" },
      },
      {
        id: 7,
        label: "object: Cache 🦞",
        retained: 95,
        incomingEdge: { type: "property", name: "nested" },
      },
      {
        id: 9,
        label: "object: Payload",
        retained: 90,
        incomingEdge: { type: "property", name: "payload" },
      },
    ],
  });
  const shared = result.retainers.find((row: { id: number }) => row.id === 11);
  expect(shared.rootPath.nodes.map((node: { id: number }) => node.id)).toEqual([1, 3, 11]);
  expect(shared.dominatorPath.nodes.map((node: { id: number }) => node.id)).toEqual([1, 11]);
  expect(result.retainers.find((row: { id: number }) => row.id === 15)).toEqual({
    id: 15,
    label: "object: WeakOnly",
    retained: 0,
    rootPath: null,
    dominatorPath: null,
  });
});

it("compares standalone snapshots without treating reused or changed IDs as object identity", () => {
  const before = snapshot([
    {
      id: 1,
      name: "root",
      size: 0,
      edges: [
        [0, 1, "cache"],
        [0, 3, "other"],
      ],
    },
    { id: 3, name: "Cache", size: 10, edges: [[0, 2, "payload"]] },
    { id: 5, name: "Payload", size: 40, edges: [] },
    { id: 7, name: "Other", size: 20, edges: [] },
  ]);
  const after = snapshot([
    {
      id: 101,
      name: "root",
      size: 0,
      edges: [
        [0, 1, "cache"],
        [0, 3, "other"],
      ],
    },
    { id: 7, name: "Cache", size: 10, edges: [[0, 2, "payload"]] },
    { id: 3, name: "Payload", size: 40, edges: [] },
    { id: 303, name: "Other", size: 20, edges: [] },
  ]);
  const result = runDiff(before, after, [
    "--independent-ids",
    "--top",
    "2",
    "--node",
    "3",
    "--node",
    "303",
  ]);

  expect(Object.keys(result).toSorted()).toEqual(["after", "before", "classes", "notes"]);
  expect(result.classes).toEqual([]);
  expect(result.before.dominators).toEqual([
    { id: 1, label: "object: root", retained: 70 },
    { id: 3, label: "object: Cache", retained: 50 },
  ]);
  expect(result.after.dominators).toEqual([
    { id: 101, label: "object: root", retained: 70 },
    { id: 7, label: "object: Cache", retained: 50 },
  ]);
  expect(result.before.retainers.map((row: { id: number }) => row.id)).toEqual([1, 3]);
  expect(result.after.retainers.map((row: { id: number }) => row.id)).toEqual([101, 7, 3, 303]);
  const oldCache = result.before.retainers.find((row: { id: number }) => row.id === 3);
  expect(oldCache.rootPath).toEqual({
    depth: 1,
    omittedAncestors: 0,
    nodes: [
      { id: 1, label: "object: root", retained: 70 },
      {
        id: 3,
        label: "object: Cache",
        retained: 50,
        incomingEdge: { type: "property", name: "cache" },
      },
    ],
  });
  const newPayload = result.after.retainers.find((row: { id: number }) => row.id === 3);
  expect(newPayload.rootPath).toEqual({
    depth: 2,
    omittedAncestors: 0,
    nodes: [
      { id: 101, label: "object: root", retained: 70 },
      {
        id: 7,
        label: "object: Cache",
        retained: 50,
        incomingEdge: { type: "property", name: "cache" },
      },
      {
        id: 3,
        label: "object: Payload",
        retained: 40,
        incomingEdge: { type: "property", name: "payload" },
      },
    ],
  });
  expect(newPayload.dominatorPath.nodes).toEqual([
    { id: 101, label: "object: root", retained: 70 },
    { id: 7, label: "object: Cache", retained: 50 },
    { id: 3, label: "object: Payload", retained: 40 },
  ]);
});
