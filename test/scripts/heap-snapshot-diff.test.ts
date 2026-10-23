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

function makeNode(id: number, name: string, size: number, edges: FixtureNode["edges"] = []) {
  return { id, name, size, edges };
}

function fixture(grown: boolean) {
  const growthEdges: FixtureNode["edges"] = grown ? [[0, 8]] : [];
  const growthNodes: FixtureNode[] = grown
    ? [makeNode(17, "Cache 🦞", 5, [[0, 9]]), makeNode(19, "Payload", 20)]
    : [];
  const nodes: FixtureNode[] = [
    makeNode(1, "root", 0, [[0, 1, "cache"], [0, 2], [1, 7], [2, 4, "shortcut"], ...growthEdges]),
    makeNode(3, "Cache 🦞", 10, [
      [0, 3, "nested"],
      [0, 5, "shared"],
    ]),
    makeNode(5, "Cache 🦞", 20, [[0, 5]]),
    makeNode(7, "Cache 🦞", 5, [[0, 4, "payload"]]),
    makeNode(9, "Payload", grown ? 90 : 40, [[0, 3]]),
    makeNode(11, "Shared", grown ? 70 : 30),
    makeNode(13, "Detached", 1_000, [[0, 1]]),
    makeNode(15, "WeakOnly", 2_000),
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
    nodes: nodes.flatMap(({ name, id, size, edges }) => [
      0,
      strings.indexOf(name),
      id,
      size,
      edges.length,
    ]),
    edges: nodes.flatMap(({ edges }) =>
      edges.flatMap(([type, target, name]) => [type, strings.indexOf(name ?? "ref"), target * 5]),
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

function retained(id: number, name: string, bytes: number, edge?: string) {
  return {
    id,
    label: `object: ${name}`,
    retained: bytes,
    ...(edge ? { incomingEdge: { type: "property", name: edge } } : {}),
  };
}

function classDelta(name: string, before: number, after: number, count: number, shallow: number) {
  return {
    label: `object: ${name}`,
    before,
    after,
    delta: after - before,
    countDelta: count,
    shallowDelta: shallow,
  };
}

it("diffs exclusive retained sizes and named strong paths without double-counting shared or nested objects", () => {
  const result = runDiff(fixture(false), fixture(true), ["--max-depth", "3", "--node", "15"]);

  expect(result.before).toEqual({ nodes: 8, reachable: 6 });
  expect(result.after).toEqual({ nodes: 10, reachable: 8 });
  expect(result.classes).toEqual(
    expect.arrayContaining([
      classDelta("Cache 🦞", 75, 150, 1, 5),
      classDelta("Shared", 30, 70, 0, 40),
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
      retained(3, "Cache 🦞", 105, "cache"),
      retained(7, "Cache 🦞", 95, "nested"),
      retained(9, "Payload", 90, "payload"),
    ],
  });
  const shared = result.retainers.find((row: { id: number }) => row.id === 11);
  expect(shared.rootPath.nodes.map((node: { id: number }) => node.id)).toEqual([1, 3, 11]);
  expect(shared.dominatorPath.nodes.map((node: { id: number }) => node.id)).toEqual([1, 11]);
  expect(result.retainers.find((row: { id: number }) => row.id === 15)).toEqual({
    ...retained(15, "WeakOnly", 0),
    rootPath: null,
    dominatorPath: null,
  });
});

it("compares standalone snapshots without treating reused or changed IDs as object identity", () => {
  const independent = (root: number, cache: number, payload: number, other: number) =>
    snapshot([
      makeNode(root, "root", 0, [
        [0, 1, "cache"],
        [0, 3, "other"],
      ]),
      makeNode(cache, "Cache", 10, [[0, 2, "payload"]]),
      makeNode(payload, "Payload", 40),
      makeNode(other, "Other", 20),
    ]);
  const before = independent(1, 3, 5, 7);
  const after = independent(101, 7, 3, 303);
  const args = ["--independent-ids", "--top", "2", "--node", "3", "--node", "303"];
  const result = runDiff(before, after, args);

  expect(Object.keys(result).toSorted()).toEqual(["after", "before", "classes", "notes"]);
  expect(result.classes).toEqual([]);
  expect(result.before.dominators).toEqual([retained(1, "root", 70), retained(3, "Cache", 50)]);
  expect(result.after.dominators).toEqual([retained(101, "root", 70), retained(7, "Cache", 50)]);
  expect(result.before.retainers.map((row: { id: number }) => row.id)).toEqual([1, 3]);
  expect(result.after.retainers.map((row: { id: number }) => row.id)).toEqual([101, 7, 3, 303]);
  const oldCache = result.before.retainers.find((row: { id: number }) => row.id === 3);
  expect(oldCache.rootPath).toEqual({
    depth: 1,
    omittedAncestors: 0,
    nodes: [retained(1, "root", 70), retained(3, "Cache", 50, "cache")],
  });
  const newPayload = result.after.retainers.find((row: { id: number }) => row.id === 3);
  expect(newPayload.rootPath).toEqual({
    depth: 2,
    omittedAncestors: 0,
    nodes: [
      retained(101, "root", 70),
      retained(7, "Cache", 50, "cache"),
      retained(3, "Payload", 40, "payload"),
    ],
  });
  expect(newPayload.dominatorPath.nodes).toEqual([
    retained(101, "root", 70),
    retained(7, "Cache", 50),
    retained(3, "Payload", 40),
  ]);
});
