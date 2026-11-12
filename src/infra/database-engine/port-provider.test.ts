import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitDatabasePortDescriptor } from "./port-descriptor.js";
import { fixtureDescriptor } from "./port-provider-fixture.test-support.js";
import { requireDatabasePortProvider, sqliteDatabasePortProvider } from "./port-provider.js";
import { createPortTableDigest } from "./port-row-digest.js";
import { inspectDatabasePort } from "./port.worker.js";

function fixture(fragments: readonly string[] = []) {
  const descriptor = fixtureDescriptor();
  const db = openNodeSqliteDatabase(":memory:");
  db.exec(descriptor.sqlite);
  for (const fragment of descriptor.fragments ?? []) {
    if (fragments.includes(fragment.id)) {
      db.exec(fragment.sqlite);
    }
  }
  const endpoint = { engine: "sqlite" as const, db };
  return {
    db,
    descriptor,
    admit: () => admitDatabasePortDescriptor(endpoint, descriptor),
    [Symbol.dispose]: () => db.close(),
  };
}

it.each([{ fragments: [] }, { fragments: ["labels"] }, { fragments: ["labels", "notes"] }])(
  "infers, orders and composes admitted fragments %j after a canonical trigger",
  async ({ fragments }) => {
    using f = fixture(fragments);
    f.descriptor.fragments = f.descriptor.fragments!.toReversed();
    const admitted = await f.admit();
    expect(admitted.activeFragments).toEqual(fragments);
    using destination = openNodeSqliteDatabase(":memory:");
    expect(() => destination.exec(admitted.sqlite)).not.toThrow();
  },
);

const both = ["labels", "notes"];
it.each<[string, string[], string]>([
  ["missing", ["notes"], "Port fragment notes requires missing fragment labels"],
  ["cycle", both, "Cyclic port fragment dependency: labels"],
])("refuses a %s fragment selection", async (kind, fragments, message) => {
  using f = fixture(fragments);
  if (kind === "cycle") {
    for (const fragment of f.descriptor.fragments!) {
      fragment.dependencies = fragment.id === "labels" ? ["notes"] : ["labels"];
    }
  }
  await expect(f.admit()).rejects.toThrow(message);
});

it.each([
  ["trigger", "CREATE TRIGGER surprise AFTER INSERT ON port_items BEGIN SELECT 1; END"],
  ["view", "CREATE VIEW surprise AS SELECT * FROM port_items"],
])("refuses an undeclared SQLite %s", async (_kind, sql) => {
  using f = fixture();
  f.db.exec(sql);
  await expect(f.admit()).rejects.toThrow("Unknown SQLite table, trigger or view");
});

it("names supported families when an id or SQLite store is unknown", () => {
  expect(() => requireDatabasePortProvider("unknown")).toThrow(
    "Unknown database family; supported families: workboard, state, agent, logbook, team-reports",
  );
  using source = openNodeSqliteDatabase(":memory:");
  source.exec("CREATE TABLE unrelated (id TEXT)");
  expect(() => sqliteDatabasePortProvider(source)).toThrow(
    "Unclassified SQLite store; supported families: workboard",
  );
});

it("refuses source fragments that differ from the recorded backup", async () => {
  using f = fixture(["labels", "notes"]);
  await expect(
    admitDatabasePortDescriptor({ engine: "sqlite", db: f.db }, f.descriptor, ["labels"]),
  ).rejects.toThrow("Port source fragments differ from the recorded backup");
});

it("omits stale derived projection rows from copy verification", async () => {
  using f = fixture();
  f.db.exec(
    "INSERT INTO port_items VALUES ('first', 'retained', 6); INSERT INTO port_projection VALUES ('wrong', 'stale projection')",
  );
  const verification = await inspectDatabasePort({ engine: "sqlite", db: f.db }, f.descriptor);
  expect(Object.keys(verification.tables)).toEqual(["port_items"]);
  expect(verification.tables.port_items?.rows).toBe(1);
});

// Untyped columns let one column hold every SQLite storage class.
async function cellsDigest(
  rows: readonly (readonly [SQLInputValue, SQLInputValue])[],
  { legacyDigest = false, columns = ["a", "b"] } = {},
) {
  using db = openNodeSqliteDatabase(":memory:", { readBigInts: true });
  const sqlite = `CREATE TABLE cells (id INTEGER PRIMARY KEY NOT NULL, ${columns.join(", ")});`;
  db.exec(sqlite);
  const insert = db.prepare("INSERT INTO cells (id, a, b) VALUES (?, ?, ?)");
  rows.forEach(([a, b], index) => insert.run(index + 1, a, b));
  const descriptor = {
    ...fixtureDescriptor(),
    fragments: [],
    projections: [],
    triggers: [],
    sqlite,
    tables: [
      {
        name: "cells",
        pk: ["id"],
        identities: [],
        columns: ["id", ...columns].map((name) => ({
          name,
          type: name === "id" ? "bigint" : "text",
        })),
      },
    ],
  };
  const verification = await inspectDatabasePort(
    { engine: "sqlite", db },
    descriptor,
    undefined,
    false,
    legacyDigest,
  );
  return verification.tables.cells!.sha256;
}

it("keeps value boundaries, nulls, integers, reals, text and blobs apart in typed row digests", async () => {
  const blob = new Uint8Array(70_000).fill(7);
  const changed = blob.slice();
  changed[69_999] = 8;
  const variants: [string, (readonly [SQLInputValue, SQLInputValue])[]][] = [
    ["split text", [["a", "b"]]],
    ["joined text", [["ab", ""]]],
    ["joined text and null", [["ab", null]]],
    ["null", [[null, "x"]]],
    ["empty text", [["", "x"]]],
    ["empty blob", [[new Uint8Array(0), "x"]]],
    ["integer", [[1n, "x"]]],
    ["real", [[1.5, "x"]]],
    ["integer text", [["1", "x"]]],
    ["integer blob", [[Buffer.from("1"), "x"]]],
    ["large blob", [[blob, "x"]]],
    ["changed large blob", [[changed, "x"]]],
    ["swapped values", [["x", blob]]],
    [
      "two rows",
      [
        ["a", "b"],
        ["a", "b"],
      ],
    ],
  ];
  const digests = await Promise.all(variants.map(([, rows]) => cellsDigest(rows)));
  expect(new Set(digests).size).toBe(variants.length);
  expect(await cellsDigest([["a", "b"]], { columns: ["b", "a"] })).not.toBe(digests[0]);
  // PostgreSQL int4 and boolean cells arrive as numbers; integral REAL keeps the legacy number domain.
  // Bound JS numbers store as REAL.
  expect(await cellsDigest([[2, "x"]])).toBe(await cellsDigest([[2n, "x"]]));
});

it("matches an unbuffered typed-v1 reference encoder across chunk boundaries", () => {
  const columns = [
    { name: "t", type: "text" },
    { name: "b", type: "bytea" },
    { name: "n", type: "bigint" },
  ];
  // Independent of the 64 KiB scratch buffer: one hash update per field.
  const reference = (rows: Record<string, SQLInputValue>[]) => {
    const hash = createHash("sha256").update(JSON.stringify(columns) + "\n");
    const head = (tag: number, write: (b: Buffer) => void) => {
      const b = Buffer.alloc(9);
      b[0] = tag;
      write(b.subarray(1));
      hash.update(b);
    };
    for (const row of rows) {
      for (const { name } of columns) {
        const value = row[name];
        if (value === null) {
          head(0, () => {});
        } else if (typeof value === "bigint") {
          head(1, (b) => b.writeBigInt64BE(value));
        } else if (typeof value === "string") {
          const bytes = Buffer.from(value, "utf8");
          head(3, (b) => b.writeBigUInt64BE(BigInt(bytes.length)));
          hash.update(bytes);
        } else {
          const bytes = Buffer.from(value as Uint8Array);
          head(4, (b) => b.writeBigUInt64BE(BigInt(bytes.length)));
          hash.update(bytes);
        }
      }
    }
    return { rows: rows.length, sha256: hash.digest("hex") };
  };
  const actual = (rows: Record<string, SQLInputValue>[]) => {
    const digest = createPortTableDigest(columns, false);
    rows.forEach((row) => digest.add(row));
    return digest.result();
  };
  const cases: Record<string, SQLInputValue>[][] = [];
  for (let size = 65_527; size <= 65_545; size++) {
    cases.push([
      { t: "x".repeat(size), b: new Uint8Array(size).fill(size % 251), n: BigInt(size) },
      { t: "after", b: new Uint8Array(3), n: -1n },
    ]);
    cases.push([{ t: "é".repeat(size >> 1) + "€😀", b: null, n: null }]);
  }
  cases.push(
    Array.from({ length: 20_000 }, (_, i) => ({
      t: i % 3 ? `row-${i}-ü€😀` : "",
      b: i % 5 ? Buffer.from([i & 255, i >> 8]) : new Uint8Array(0),
      n: i % 7 ? BigInt(i) * -9_000_000_000n : null,
    })),
  );
  cases.push([{ t: "", b: null, n: null }], [{ t: null, b: new Uint8Array(0), n: null }]);
  for (const rows of cases) {
    expect(actual(rows)).toEqual(reference(rows));
  }
  expect(actual(cases.at(-2)!)).not.toEqual(actual(cases.at(-1)!));
  expect(() => actual([{ t: null, b: null, n: 2n ** 63n }])).toThrow("outside 64 bits");
  expect(() => actual([{ t: null, b: null, n: -(2n ** 63n) - 1n }])).toThrow("outside 64 bits");
});

it("keeps recorded row digest formats stable", async () => {
  const rows = [
    ["text", Buffer.from([0, 255])],
    [null, 9007199254740993n],
  ] as const;
  // Recorded by builds before typed row digests; their proofs still verify.
  expect(await cellsDigest(rows, { legacyDigest: true })).toBe(
    "95731de4851ab862152ca2aca13eac5b9a44d8dd4fc2a2444468408167241a42",
  );
  // typed-v1, persisted in backup manifests and port receipts.
  expect(await cellsDigest(rows)).toBe(
    "8f9444ad4d3169a8e9532ed154245b26d5b7991fb2bf32c7996225c0b79d4cfa",
  );
});

it("selects the registered family by id and admitted SQLite tables", () => {
  using source = openNodeSqliteDatabase(":memory:");
  source.exec("CREATE TABLE workboard_schema_migrations (id TEXT)");
  expect(sqliteDatabasePortProvider(source)).toBe(requireDatabasePortProvider("workboard"));
});
