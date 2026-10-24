import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type FixtureNode = {
  id: number;
  name: string;
  size: number;
  type?: "object" | "string" | "array" | "closure" | "sliced string" | "concatenated string";
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
        node_types: [
          ["object", "string", "array", "closure", "sliced string", "concatenated string"],
          "string",
          "number",
          "number",
          "number",
        ],
        edge_fields: ["type", "name_or_index", "to_node"],
        edge_types: [
          ["property", "weak", "shortcut", "internal", "element"],
          "string_or_number",
          "node",
        ],
      },
      node_count: nodes.length,
      edge_count: nodes.reduce((sum, node) => sum + node.edges.length, 0),
    },
    nodes: nodes.flatMap(({ name, id, size, edges, type = "object" }) => [
      ["object", "string", "array", "closure", "sliced string", "concatenated string"].indexOf(
        type,
      ),
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

function runSummary(contents: string, labels: string[] = [], args: string[] = []) {
  const directory = tempDirs.make("heap-summary-");
  const file = path.join(directory, "snapshot.heapsnapshot");
  const allowlist = path.join(directory, "source-labels.txt");
  writeFileSync(file, contents);
  writeFileSync(allowlist, labels.join("\n"));
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["scripts/heap-snapshot-diff.mjs", "--summary", file, "--labels", allowlist, ...args],
      { encoding: "utf8" },
    ),
  );
}

it("summarizes one snapshot's known dominators and constructor unions with cycles and shared retainers", () => {
  const result = runSummary(fixture(false), ["root", "Cache 🦞", "Payload", "Shared"]);
  expect(result).toMatchObject({ nodes: 8, reachable: 6, retainedBytes: 105 });
  expect(result.classes).toEqual(
    expect.arrayContaining([
      { label: "object: Cache 🦞", count: 3, shallow: 35, retained: 75 },
      { label: "object: Shared", count: 1, shallow: 30, retained: 30 },
    ]),
  );
  expect(result.dominators).toEqual(
    expect.arrayContaining([
      { id: 3, label: "object: Cache 🦞", shallow: 10, retained: 55 },
      { id: 7, label: "object: Cache 🦞", shallow: 5, retained: 45 },
    ]),
  );
  expect(result.dominators.map((row: { id: number }) => row.id)).not.toContain(13);
  expect(result.dominators.map((row: { id: number }) => row.id)).not.toContain(15);
  const shared = result.retainers.find((row: { id: number }) => row.id === 11);
  expect(shared.dominatorPath.nodes.map((row: { id: number }) => row.id)).toEqual([1, 11]);
  expect(shared.rootPath.nodes.map((row: { id: number }) => row.id)).toEqual([1, 3, 11]);
});

it("reports collections, duplicate flat strings and session scaling without emitting snapshot payloads", () => {
  const message = 'private message with "quotes", \\ and 🦞';
  const sessionA = "agent:private-agent:private-session-a";
  const sessionB = "agent:private-agent:private-session-b";
  const sessionC = "agent:private-agent:private-session-c";
  const contents = snapshot([
    makeNode(1, "ApprovedOwnerSuffix", 0, [
      [0, 1, "approvedProperty"],
      [0, 6],
      [0, 8],
      [0, 10],
      [0, 12],
      [0, 13],
      [0, 14],
    ]),
    makeNode(3, "Map", 40, [[3, 2, "table"]]),
    {
      ...makeNode(5, "", 24, [
        [3, 3],
        [3, 4],
        [3, 5],
      ]),
      type: "array",
    },
    { ...makeNode(7, sessionA, 32), type: "string" },
    makeNode(9, "ApprovedOwner", 64),
    { ...makeNode(11, sessionB, 40), type: "string" },
    makeNode(13, "Set", 40, [[3, 7, "table"]]),
    { ...makeNode(15, "", 24, [[3, 3]]), type: "array" },
    makeNode(17, "Array", 32, [[4, 9]]),
    { ...makeNode(19, message, 30), type: "string" },
    makeNode(21, "Object", 24, [
      [0, 11, sessionC],
      [0, 12, "private-property"],
    ]),
    { ...makeNode(23, message, 34), type: "string" },
    { ...makeNode(25, "PrivateClosure", 16), type: "closure" },
    { ...makeNode(27, message, 16), type: "sliced string" },
    { ...makeNode(29, message, 16), type: "concatenated string" },
  ]);
  const result = runSummary(contents, ["ApprovedOwner", "approvedProperty"]);
  expect(result).toMatchObject({ nodes: 15, reachable: 15, retainedBytes: 432 });
  expect(result.duplicateStrings).toEqual({
    groups: 1,
    copies: 1,
    shallowBytes: 64,
    potentialSavingsBytes: 30,
    excludedTruncatedGroups: 0,
    excludedTruncatedShallowBytes: 0,
    stringLimit: 1024,
  });
  expect(result.collections).toEqual(
    expect.arrayContaining([
      { id: 3, label: "object: Map", shallow: 40, retained: 168 },
      { id: 5, label: "array", shallow: 24, retained: 128 },
      { id: 13, label: "object: Set", shallow: 40, retained: 64 },
      { id: 17, label: "object: Array", shallow: 32, retained: 62 },
    ]),
  );
  expect(result.sessionStructures).toEqual(
    expect.arrayContaining([
      {
        id: 3,
        label: "object: Map",
        shallow: 40,
        retained: 168,
        sessionKeyReferences: 2,
        retainedBytesPerKeyReference: 84,
      },
      {
        id: 13,
        label: "object: Set",
        shallow: 40,
        retained: 64,
        sessionKeyReferences: 1,
        retainedBytesPerKeyReference: 64,
      },
      {
        id: 21,
        label: "object: Object",
        shallow: 24,
        retained: 58,
        sessionKeyReferences: 1,
        retainedBytesPerKeyReference: 58,
      },
    ]),
  );
  const output = JSON.stringify(result);
  for (const secret of [
    "private message",
    sessionA,
    sessionB,
    sessionC,
    "private-property",
    "PrivateClosure",
    "ApprovedOwnerSuffix",
  ]) {
    expect(output).not.toContain(secret);
  }
  expect(result.classes).toContainEqual({
    label: "object: ApprovedOwner",
    count: 1,
    shallow: 64,
    retained: 64,
  });
  const map = result.retainers.find((row: { id: number }) => row.id === 3);
  expect(map.rootPath.nodes.at(-1).incomingEdge).toEqual({
    type: "property",
    name: "approvedProperty",
  });
  expect(JSON.stringify(runSummary(contents))).not.toContain("ApprovedOwner");
});

it.each([
  { stringLimit: 1024, args: [] },
  { stringLimit: 8, args: ["--string-limit", "8"] },
])(
  "excludes ambiguous duplicate prefixes at the snapshot string limit $stringLimit",
  ({ stringLimit, args }) => {
    // V8 can intern different long strings under one truncated strings-table entry.
    const prefix = "z".repeat(stringLimit);
    const complete = "y".repeat(stringLimit - 1);
    const contents = snapshot([
      makeNode(1, "Object", 0, [
        [0, 1],
        [0, 2],
        [0, 3],
        [0, 4],
      ]),
      { ...makeNode(3, prefix, 1200), type: "string" },
      { ...makeNode(5, prefix, 1300), type: "string" },
      { ...makeNode(7, complete, 30), type: "string" },
      { ...makeNode(9, complete, 34), type: "string" },
    ]);
    expect(runSummary(contents, [], args).duplicateStrings).toEqual({
      groups: 1,
      copies: 1,
      shallowBytes: 64,
      potentialSavingsBytes: 30,
      excludedTruncatedGroups: 1,
      excludedTruncatedShallowBytes: 2500,
      stringLimit,
    });
  },
);

it("rejects summary flags that could accidentally select the unsanitized comparison mode", () => {
  for (const args of [
    ["--summary", "before", "after"],
    ["--summary", "--independent-ids", "snapshot"],
    ["--labels", "source-labels.txt", "before", "after"],
  ]) {
    const result = spawnSync(process.execPath, ["scripts/heap-snapshot-diff.mjs", ...args], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  }
});

it("attributes excess string nodes once, preserves unreachable accounting, and exposes only reviewed owner labels", () => {
  const secret = "private repeated payload";
  const contents = snapshot([
    makeNode(1, "Object", 0, [
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 7],
      [2, 7],
    ]),
    { ...makeNode(3, secret, 40), type: "string" },
    makeNode(5, "Array", 24, [[4, 5]]),
    makeNode(7, "system / Context", 24, [[0, 4, "store"]]),
    makeNode(9, "Object", 24, [
      [0, 5, "role"],
      [0, 6, "private-edge"],
    ]),
    { ...makeNode(11, secret, 32), type: "string" },
    { ...makeNode(13, secret, 40), type: "string" },
    { ...makeNode(15, secret, 32), type: "string" },
    makeNode(17, "Object", 24, [[0, 7, "role"]]),
  ]);
  const result = runSummary(contents, ["store", "role"], ["--node", "7"]);
  expect(result.duplicateStrings.potentialSavingsBytes).toBe(104);
  expect(result.duplicateStringRetainers).toMatchObject({
    attributedBytes: 72,
    unattributedBytes: 32,
    groupCount: 2,
    groups: expect.arrayContaining([
      expect.objectContaining({
        ownerId: 7,
        retainer: "object: Object",
        edge: { type: "property", name: "role" },
        copies: 1,
        excessBytes: 32,
        multipleIncomingCopies: 1,
      }),
      expect.objectContaining({
        ownerId: 7,
        edge: { type: "property", name: "(redacted)" },
        copies: 1,
        excessBytes: 40,
        multipleIncomingCopies: 0,
      }),
    ]),
  });
  expect(result.inspectedNodes).toEqual([
    {
      id: 7,
      label: "object: system / Context",
      retained: 88,
      children: [
        {
          edge: { type: "property", name: "store" },
          id: 9,
          label: "object: Object",
          retained: 64,
          elementReferences: 0,
        },
      ],
    },
  ]);
  expect(result.retainers.some((row: { id: number }) => row.id === 9)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain("private-edge");
});
