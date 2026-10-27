import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type Edges = Array<[type: number, target: number, name?: string]>;
type FixtureNode = [
  id: number,
  name: string,
  size: number,
  edges?: Edges,
  type?: (typeof nodeTypes)[number],
];
const refs = (...targets: number[]): Edges => targets.map((target) => [0, target]);
const nodeTypes = [
  "object",
  "string",
  "array",
  "closure",
  "code",
  "sliced string",
  "concatenated string",
] as const;
const edgeTypes = ["property", "weak", "shortcut", "internal", "element", "hidden"];
const properties = (names: Record<number, string>): Edges =>
  Object.entries(names).map(([target, name]) => [0, Number(target), name]);
const internals = (...targets: number[]): Edges => targets.map((target) => [3, target]);

function fixture(grown: boolean) {
  const growthEdges: Edges = grown ? [[0, 8]] : [];
  const growthNodes: FixtureNode[] = grown
    ? [
        [17, "Cache 🦞", 5, [[0, 9]]],
        [19, "Payload", 20],
      ]
    : [];
  const nodes: FixtureNode[] = [
    [1, "root", 0, [[0, 1, "cache"], [0, 2], [1, 7], [2, 4, "shortcut"], ...growthEdges]],
    [3, "Cache 🦞", 10, properties({ 3: "nested", 5: "shared" })],
    [5, "Cache 🦞", 20, [[0, 5]]],
    [7, "Cache 🦞", 5, [[0, 4, "payload"]]],
    [9, "Payload", grown ? 90 : 40, [[0, 3]]],
    [11, "Shared", grown ? 70 : 30],
    [13, "Detached", 1_000, [[0, 1]]],
    [15, "WeakOnly", 2_000],
    ...growthNodes,
  ];
  // An unused string crosses the streaming reader's chunk boundary without becoming a class label.
  return snapshot(nodes, "x".repeat(1024 * 1024));
}

function snapshot(nodes: FixtureNode[], unusedString = "") {
  const edges = nodes.flatMap((node) => node[3] ?? []);
  const strings = [
    unusedString,
    ...new Set([...nodes.map((node) => node[1]), ...edges.map((edge) => edge[2] ?? "ref")]),
  ];
  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: ["type", "name", "id", "self_size", "edge_count"],
        node_types: [nodeTypes, "string", "number", "number", "number"],
        edge_fields: ["type", "name_or_index", "to_node"],
        edge_types: [edgeTypes, "string_or_number", "node"],
      },
      node_count: nodes.length,
      edge_count: edges.length,
    },
    nodes: nodes.flatMap(([id, name, size, outgoing = [], type = "object"]) => [
      nodeTypes.indexOf(type),
      strings.indexOf(name),
      id,
      size,
      outgoing.length,
    ]),
    edges: edges.flatMap(([type, target, name]) => [
      type,
      strings.indexOf(name ?? "ref"),
      target * 5,
    ]),
    strings,
  });
}

function run(
  snapshots: string[],
  args: string[] = [],
  labels: string[] = [],
  scripts: string[] = [],
) {
  const directory = tempDirs.make("heap-snapshot-diff-");
  const files = snapshots.map((contents, index) => {
    const file = path.join(directory, `${index}.heapsnapshot`);
    writeFileSync(file, contents);
    return file;
  });
  const mode = snapshots.length === 1 ? ["--summary"] : ["--json"];
  if (snapshots.length === 1) {
    const allowlist = path.join(directory, "source-labels.txt");
    writeFileSync(allowlist, labels.join("\n"));
    mode.push("--labels", allowlist);
  }
  if (args.includes("--code-by-script")) {
    const allowlist = path.join(directory, "script-files.txt");
    writeFileSync(allowlist, scripts.join("\n"));
    mode.push("--script-allowlist", allowlist);
  }
  return JSON.parse(
    execFileSync(process.execPath, ["scripts/heap-snapshot-diff.mjs", ...mode, ...files, ...args], {
      encoding: "utf8",
    }),
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

function retainedPath(
  depth: number,
  omittedAncestors: number,
  ...nodes: ReturnType<typeof retained>[]
) {
  return { depth, omittedAncestors, nodes };
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

function collection(id: number, label: string, shallow: number, bytes: number, keys?: number) {
  return {
    id,
    label,
    shallow,
    retained: bytes,
    ...(keys ? { sessionKeyReferences: keys, retainedBytesPerKeyReference: bytes / keys } : {}),
  };
}

function duplicates(stringLimit = 1024, excludedGroups = 0, excludedBytes = 0) {
  return {
    groups: 1,
    copies: 1,
    shallowBytes: 64,
    potentialSavingsBytes: 30,
    excludedTruncatedGroups: excludedGroups,
    excludedTruncatedShallowBytes: excludedBytes,
    stringLimit,
  };
}

it("diffs exclusive retained sizes and named strong paths without double-counting shared or nested objects", () => {
  const result = run([fixture(false), fixture(true)], ["--max-depth", "3", "--node", "15"]);

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
  expect(payload.rootPath).toEqual(
    retainedPath(
      3,
      1,
      retained(3, "Cache 🦞", 105, "cache"),
      retained(7, "Cache 🦞", 95, "nested"),
      retained(9, "Payload", 90, "payload"),
    ),
  );
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
      [root, "root", 0, properties({ 1: "cache", 3: "other" })],
      [cache, "Cache", 10, [[0, 2, "payload"]]],
      [payload, "Payload", 40],
      [other, "Other", 20],
    ]);
  const before = independent(1, 3, 5, 7);
  const after = independent(101, 7, 3, 303);
  const args = ["--independent-ids", "--top", "2", "--node", "3", "--node", "303"];
  const result = run([before, after], args);

  expect(result.dominators).toBeUndefined();
  expect(result.classes).toEqual([]);
  expect(result.before.dominators).toEqual([retained(1, "root", 70), retained(3, "Cache", 50)]);
  expect(result.after.dominators).toEqual([retained(101, "root", 70), retained(7, "Cache", 50)]);
  expect(result.before.retainers.map((row: { id: number }) => row.id)).toEqual([1, 3]);
  expect(result.after.retainers.map((row: { id: number }) => row.id)).toEqual([101, 7, 3, 303]);
  const oldCache = result.before.retainers.find((row: { id: number }) => row.id === 3);
  expect(oldCache.rootPath).toEqual(
    retainedPath(1, 0, retained(1, "root", 70), retained(3, "Cache", 50, "cache")),
  );
  const newPayload = result.after.retainers.find((row: { id: number }) => row.id === 3);
  expect(newPayload.rootPath).toEqual(
    retainedPath(
      2,
      0,
      retained(101, "root", 70),
      retained(7, "Cache", 50, "cache"),
      retained(3, "Payload", 40, "payload"),
    ),
  );
  expect(newPayload.dominatorPath.nodes).toEqual([
    retained(101, "root", 70),
    retained(7, "Cache", 50),
    retained(3, "Payload", 40),
  ]);
});

it("reports collections, duplicate flat strings and session scaling without emitting snapshot payloads", () => {
  const message = 'private message with "quotes", \\ and 🦞';
  const sessionA = "agent:private-agent:private-session-a";
  const sessionB = "agent:private-agent:private-session-b";
  const sessionC = "agent:private-agent:private-session-c";
  const contents = snapshot([
    [1, "ApprovedOwnerSuffix", 0, [[0, 1, "approvedProperty"], ...refs(6, 8, 10, 12, 13, 14)]],
    [3, "Map", 40, [[3, 2, "table"]]],
    [5, "", 24, internals(3, 4, 5), "array"],
    [7, sessionA, 32, [], "string"],
    [9, "ApprovedOwner", 64],
    [11, sessionB, 40, [], "string"],
    [13, "Set", 40, [[3, 7, "table"]]],
    [15, "", 24, [[3, 3]], "array"],
    [17, "Array", 32, [[4, 9]]],
    [19, message, 30, [], "string"],
    [21, "Object", 24, properties({ 11: sessionC, 12: "private-property" })],
    [23, message, 34, [], "string"],
    [25, "PrivateClosure", 16, [], "closure"],
    [27, message, 16, [], "sliced string"],
    [29, message, 16, [], "concatenated string"],
  ]);
  const result = run([contents], [], ["ApprovedOwner", "approvedProperty"]);
  expect(result).toMatchObject({ nodes: 15, reachable: 15, retainedBytes: 432 });
  expect(result.duplicateStrings).toEqual(duplicates());
  expect(result.collections).toEqual(
    expect.arrayContaining([
      collection(3, "object: Map", 40, 168),
      collection(5, "array", 24, 128),
      collection(13, "object: Set", 40, 64),
      collection(17, "object: Array", 32, 62),
    ]),
  );
  expect(result.sessionStructures).toEqual(
    expect.arrayContaining([
      collection(3, "object: Map", 40, 168, 2),
      collection(13, "object: Set", 40, 64, 1),
      collection(21, "object: Object", 24, 58, 1),
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
  expect(JSON.stringify(run([contents]))).not.toContain("ApprovedOwner");
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
      [1, "Object", 0, refs(1, 2, 3, 4)],
      [3, prefix, 1200, [], "string"],
      [5, prefix, 1300, [], "string"],
      [7, complete, 30, [], "string"],
      [9, complete, 34, [], "string"],
    ]);
    expect(run([contents], args).duplicateStrings).toEqual(duplicates(stringLimit, 1, 2500));
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
    [1, "Object", 0, [...refs(1, 2, 3), [1, 7], [2, 7]]],
    [3, secret, 40, [], "string"],
    [5, "Array", 24, [[4, 5]]],
    [7, "system / Context", 24, [[0, 4, "store"]]],
    [9, "Object", 24, properties({ 5: "role", 6: "private-edge" })],
    [11, secret, 32, [], "string"],
    [13, secret, 40, [], "string"],
    [15, secret, 32, [], "string"],
    [17, "Object", 24, [[0, 7, "role"]]],
  ]);
  const result = run([contents], ["--node", "7"], ["store", "role"]);
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
      ...retained(7, "system / Context", 88),
      children: [
        {
          edge: { type: "property", name: "store" },
          ...retained(9, "Object", 64),
          elementReferences: 0,
        },
      ],
    },
  ]);
  expect(result.retainers.some((row: { id: number }) => row.id === 9)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain("private-edge");
});

it("attributes compiled scripts without exposing unreviewed names or double-counting shared code", () => {
  const data = snapshot([
    [1, "root", 0, refs(1, 2, 3, 4, 5, 6, 20, 22, 23, 24, 25)],
    [
      3,
      "/product/a.mjs?secret=one",
      10,
      [
        [3, 17, "source"],
        [3, 18, "name"],
      ],
      "code",
    ],
    [
      5,
      "/product/a.mjs#secret-two",
      10,
      [
        [3, 17, "source"],
        [3, 19, "name"],
      ],
      "code",
    ],
    [
      7,
      "/private/x.mjs?secret=three",
      10,
      [
        [3, 17, "source"],
        [3, 21, "name"],
      ],
      "code",
    ],
    [
      9,
      "privateFunction",
      1,
      [
        [3, 7, "shared"],
        [3, 11, "code"],
        [3, 10, "feedback_cell"],
      ],
      "closure",
    ],
    [
      11,
      "privateFunction",
      1,
      [
        [3, 8, "shared"],
        [3, 12, "code"],
        [3, 10, "feedback_cell"],
      ],
      "closure",
    ],
    [
      13,
      "privateFunction",
      1,
      [
        [3, 9, "shared"],
        [3, 11, "code"],
        [3, 13, "feedback_cell"],
      ],
      "closure",
    ],
    [
      15,
      "privateFunction",
      20,
      [
        [3, 1, "script"],
        [3, 14, "trusted_function_data"],
        [1, 16, "weak"],
      ],
      "code",
    ],
    [
      17,
      "privateFunction",
      20,
      [
        [3, 2, "script"],
        [3, 14, "trusted_function_data"],
      ],
      "code",
    ],
    [19, "privateFunction", 20, [[3, 3, "script"]], "code"],
    [21, "system / FeedbackCell", 8, [[3, 15, "value"]], "code"],
    [23, "(code)", 30, [], "code"],
    [25, "(InterpreterEntryTrampoline builtin code)", 40, [], "code"],
    [27, "system / FeedbackCell", 8, [], "code"],
    [
      29,
      "system / BytecodeArray",
      50,
      [
        [5, 26],
        [0, 20, "property"],
      ],
      "code",
    ],
    [31, "system / FeedbackVector", 12, [], "code"],
    [33, "weak-only-code", 9000, [], "code"],
    [35, "secret source contents", 100, [], "string"],
    [37, "/product/a.mjs?secret=one", 30, [], "string"],
    [39, "/product/a.mjs#secret-two", 30, [], "string"],
    [41, "unassociated-code", 16, [], "code"],
    [43, "/private/x.mjs?secret=three", 30, [], "string"],
    [
      45,
      "/private/x.mjs#another",
      10,
      [
        [3, 17, "source"],
        [3, 21, "name"],
      ],
      "code",
    ],
    [
      47,
      "",
      10,
      [
        [3, 17, "source"],
        [3, 21, "name"],
      ],
      "code",
    ],
    [
      49,
      "",
      10,
      [
        [3, 17, "source"],
        [3, 21, "name"],
      ],
      "code",
    ],
    [
      51,
      "/product/a.mjs.evil",
      10,
      [
        [3, 17, "source"],
        [3, 21, "name"],
      ],
      "code",
    ],
    [53, "system / TrustedByteArray", 6, [[3, 27, "payload"]], "code"],
    [55, "secret payload", 70, [], "string"],
  ]);
  const report = run([data], ["--code-by-script", "--top", "1"], [], ["/product/a.mjs"]);
  const result = report.codeByScript;
  expect(result.scriptCount).toBe(7);
  expect(result.identityCount).toBe(5);
  expect(result.topScripts).toHaveLength(1);
  expect(result.duplicateScripts).toHaveLength(2);
  expect(result.topScripts[0]).toEqual({
    name: "/product/a.mjs",
    identityHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    instanceCount: 2,
    codeObjects: 8,
    shallowBytes: 136,
    retainedBytes: 266,
  });
  expect(result.duplicateScripts[1]).toMatchObject({
    name: "(redacted)",
    identityHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    instanceCount: 2,
    codeObjects: 4,
    shallowBytes: 48,
    retainedBytes: 48,
  });
  expect(result.sharedOrRuntime).toEqual({ codeObjects: 2, shallowBytes: 70, retainedBytes: 70 });
  expect(result.unattributed).toEqual({ codeObjects: 1, shallowBytes: 16, retainedBytes: 16 });
  expect(result.total).toEqual({ codeObjects: 18, shallowBytes: 300, retainedBytes: 430 });
  const text = JSON.stringify(report);
  for (const forbidden of [
    "secret",
    "/private",
    ".evil",
    "privateFunction",
    "secret source contents",
    "weak-only",
  ]) {
    expect(text).not.toContain(forbidden);
  }
  const all = run([data], ["--code-by-script"], [], ["/product/a.mjs"]).codeByScript;
  expect(
    all.topScripts.filter((row: { identityHash: string | null }) => row.identityHash === null),
  ).toHaveLength(2);
  expect(all.duplicateScripts[0].identityHash).not.toBe(all.duplicateScripts[1].identityHash);
  const truncated = run([data], ["--code-by-script", "--string-limit", "8"]).codeByScript;
  expect(truncated.duplicateScripts).toEqual([]);
  expect(truncated.topScripts).toHaveLength(7);
  expect(
    truncated.topScripts.every((row: { identityHash: string | null }) => row.identityHash === null),
  ).toBe(true);
});

it("matches decorated V8 Script labels and keeps unnamed scripts separate", () => {
  const script = (id: number, name: string): FixtureNode => [
    id,
    name,
    10,
    [
      [3, 5, "source"],
      [3, 6, "name"],
    ],
    "code",
  ];
  const data = snapshot([
    [1, "root", 0, refs(1, 2, 3, 4)],
    script(3, "system / Script / /product/b.mjs?one"),
    script(5, "system / Script / /product/b.mjs#two"),
    script(7, "system / Script"),
    script(9, "system / Script"),
    [11, "secret source contents", 20, [], "string"],
    [13, "script name", 10, [], "string"],
  ]);
  const result = run([data], ["--code-by-script"], [], ["/product/b.mjs"]).codeByScript;
  expect(result.scriptCount).toBe(4);
  expect(result.duplicateScripts).toEqual([
    expect.objectContaining({ name: "/product/b.mjs", instanceCount: 2 }),
  ]);
  expect(
    result.topScripts.filter((row: { identityHash: string | null }) => row.identityHash === null),
  ).toHaveLength(2);
});

it("unions flat and shared rope source strings without counting other script data", () => {
  const script = (id: number, name: string, source: number): FixtureNode => [
    id,
    name,
    10,
    [
      [3, source, "source"],
      [3, 10, "name"],
      [3, 11, "unrelated"],
    ],
    "code",
  ];
  const data = snapshot([
    [1, "root", 0, refs(1, 2, 3, 4, 11, 12)],
    script(3, "/product/a.mjs?private", 5),
    script(5, "/product/a.mjs#private", 6),
    script(7, "/private/b.mjs", 7),
    script(9, "/product/flat.mjs", 13),
    [
      11,
      "rope",
      32,
      [
        [3, 6, "first"],
        [3, 8, "second"],
        [1, 12, "weak"],
      ],
      "concatenated string",
    ],
    [13, "slice", 24, [[3, 9, "parent"]], "sliced string"],
    [15, "other slice", 24, [[3, 9, "parent"]], "sliced string"],
    [17, "secret flat contents", 40, [], "string"],
    [19, "secret backing contents", 100, [], "string"],
    [21, "private script name", 500, [], "string"],
    [23, "unrelated string", 1000, [], "string"],
    [25, "weak string", 2000, [], "string"],
    [27, "secret independent flat contents", 60, [], "string"],
  ]);
  const report = run(
    [data],
    ["--code-by-script", "--top", "2"],
    [],
    ["/product/a.mjs", "/product/flat.mjs"],
  );
  expect(report.codeByScript.sourceStrings).toEqual({
    stringNodes: 6,
    shallowBytes: 280,
    topScripts: [
      {
        name: "/product/a.mjs",
        identityHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        instanceCount: 2,
        stringNodes: 4,
        shallowBytes: 196,
      },
      {
        name: "(redacted)",
        identityHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        instanceCount: 1,
        stringNodes: 2,
        shallowBytes: 124,
      },
    ],
  });
  expect(report.codeByScript.sourceStrings.topScripts[0].identityHash).toBe(
    report.codeByScript.duplicateScripts[0].identityHash,
  );
  for (const forbidden of ["private", "secret", "unrelated string", "weak string"]) {
    expect(JSON.stringify(report)).not.toContain(forbidden);
  }
});
