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
  edges: Array<[type: number, target: number]>;
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
      edges: [[0, 1], [0, 2], [1, 7], [2, 4], ...growthEdges],
    },
    {
      id: 3,
      name: "Cache 🦞",
      size: 10,
      edges: [
        [0, 3],
        [0, 5],
      ],
    },
    { id: 5, name: "Cache 🦞", size: 20, edges: [[0, 5]] },
    { id: 7, name: "Cache 🦞", size: 5, edges: [[0, 4]] },
    { id: 9, name: "Payload", size: grown ? 90 : 40, edges: [[0, 3]] },
    { id: 11, name: "Shared", size: grown ? 70 : 30, edges: [] },
    { id: 13, name: "Detached", size: 1_000, edges: [[0, 1]] },
    { id: 15, name: "WeakOnly", size: 2_000, edges: [] },
    ...growthNodes,
  ];
  // An unused string crosses the streaming reader's chunk boundary without becoming a class label.
  const strings = ["x".repeat(1024 * 1024), ...new Set(nodes.map((node) => node.name))];
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
    edges: nodes.flatMap((node) => node.edges.flatMap(([type, target]) => [type, 0, target * 5])),
    strings,
  });
}

it("diffs dominator retention without counting shared, weak, detached, or nested same-class bytes twice", () => {
  const directory = tempDirs.make("heap-snapshot-diff-");
  const before = path.join(directory, "before.heapsnapshot");
  const after = path.join(directory, "after.heapsnapshot");
  writeFileSync(before, fixture(false));
  writeFileSync(after, fixture(true));
  const result = JSON.parse(
    execFileSync(process.execPath, ["scripts/heap-snapshot-diff.mjs", before, after, "--json"], {
      encoding: "utf8",
    }),
  );

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
});
