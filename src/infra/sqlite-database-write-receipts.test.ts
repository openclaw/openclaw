import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  SqliteDatabaseGenerationSlot,
  SqliteDatabaseAdmissionRegistry,
  createSqliteDatabaseAdmissionCursor,
  readSqliteDatabaseGeneration,
  type Admission,
} from "./sqlite-database-admission-record.js";
import {
  createSqliteDatabaseWriteReceipts,
  sqliteSessionIdWriteScope,
} from "./sqlite-database-write-receipts.js";

function createAdmission(): Admission {
  return {
    identity: "receipt-test",
    location: ":memory:",
    descriptor: -1,
    descriptorOwner: 0,
    generationId: "receipt-test",
    physicalIdentity: { key: "file:1:1", birthtime: "0" },
    generation: new SharedArrayBuffer(
      Int32Array.BYTES_PER_ELEMENT * Object.keys(SqliteDatabaseGenerationSlot).length,
    ),
    writerDiagnostic: new Int32Array(new SharedArrayBuffer(125 * Int32Array.BYTES_PER_ELEMENT)),
    facts: new Map(),
    writeScopes: new Map(),
    writeScopeRevision: 0,
    references: new Map(),
  };
}

function publishScopeRevision(record: Admission) {
  Atomics.store(
    new Int32Array(record.generation),
    SqliteDatabaseGenerationSlot.writeScopeRevision,
    record.writeScopes.size,
  );
}

function createReceipts(
  record: Admission,
  overrides: Partial<Parameters<typeof createSqliteDatabaseWriteReceipts>[0]> = {},
) {
  return createSqliteDatabaseWriteReceipts({
    admission: () => record,
    pathAdmission: () => record,
    retain: () => {},
    release: () => {},
    writeListeners: new WeakMap(),
    readRevision: () => 0,
    writer: () => record,
    suspended: () => false,
    hasPendingSchemaMutation: () => false,
    publish: publishScopeRevision,
    ...overrides,
  });
}

it("publishes cohort scope discovery once and preserves independent write receipts", () => {
  using database = new DatabaseSync(":memory:");
  const record = createAdmission();
  const publications: number[] = [];
  const receipts = createReceipts(record, {
    publish: (current) => {
      publishScopeRevision(current);
      current.writeScopeRevision = readSqliteDatabaseGeneration(current, "writeScopeRevision");
      publications.push(current.writeScopes.size);
    },
  });
  const scopes = [
    ["first", sqliteSessionIdWriteScope("first-id")],
    ["second", sqliteSessionIdWriteScope("second-id")],
  ];
  const before = receipts.readSqliteDatabaseScopedWriteTokensForPath(":memory:", scopes)!;
  expect(before.map((token) => typeof token)).toEqual(["string", "string"]);
  expect(publications).toEqual([4]);
  expect(receipts.readSqliteDatabaseScopedWriteTokensForPath(":memory:", scopes)).toEqual(before);
  expect(publications).toEqual([4]);

  receipts.withSqliteDatabaseWriteScope(database, ["second"], () => {
    receipts.begin(database, false);
    receipts.finish(database, record);
  });
  const after = receipts.readSqliteDatabaseScopedWriteTokensForPath(":memory:", scopes)!;
  expect(after[0]).toBe(before[0]);
  expect(after[1]).not.toBe(before[1]);
  expect(after).toEqual(
    scopes.map((scope) => receipts.readSqliteDatabaseScopedWriteTokenForPath(":memory:", scope)),
  );
  expect(publications).toEqual([4]);
});

it("publishes scope discovery and reference installs without revisiting unchanged scopes", () => {
  const record = createAdmission();
  const references = new SharedArrayBuffer(8);
  Atomics.store(new Int32Array(references), 0, 1);
  record.references.set(0, references);
  const registry = new SqliteDatabaseAdmissionRegistry();
  registry.records.set(record.identity, record);
  const receipts = createReceipts(record, {
    publish: (current, keys) => registry.publish(current, keys),
  });
  const cursor = createSqliteDatabaseAdmissionCursor();
  const initial = receipts.readSqliteDatabaseScopedWriteTokensForPath(
    ":memory:",
    Array.from({ length: 256 }, (_, index) => `existing-${index}`),
  );
  const [before] = registry.capture(cursor);
  let visited = 0;
  for (const revision of record.writeScopes.values()) {
    const state = revision.state;
    Object.defineProperty(revision, "state", {
      get() {
        visited++;
        return state;
      },
    });
  }

  registry.install([
    {
      ...record,
      facts: new Map(),
      writeScopes: [],
      references: new Map([[123, references]]),
    },
  ]);
  expect(visited).toBe(0);
  expect([...registry.capture(cursor)[0]!.references.keys()]).toEqual([123]);

  // Worker discovery creates a cell without advancing the host's shared revision.
  const importer = createAdmission();
  createReceipts(importer, { publish: () => {} }).readSqliteDatabaseScopedWriteTokenForPath(
    ":memory:",
    "imported",
  );
  registry.install([{ ...record, writeScopes: [importer.writeScopes] }]);
  expect(visited).toBe(0);
  expect(
    registry.capture(cursor)[0]!.writeScopes.flatMap((bucket) => Array.from(bucket.keys())),
  ).toEqual(['["key","imported"]']);

  registry.install([
    {
      ...record,
      facts: new Map(),
      writeScopes: [],
      references: new Map([[124, references]]),
    },
  ]);
  expect(visited).toBe(0);
  expect([...registry.capture(cursor)[0]!.references.keys()]).toEqual([124]);
  registry.capture();
  expect(visited).toBe(0);

  const added = receipts.readSqliteDatabaseScopedWriteTokenForPath(":memory:", "new");
  expect(visited).toBe(0);
  const [delta] = registry.capture(cursor);
  expect(delta!.writeScopes.flatMap((bucket) => Array.from(bucket.keys()))).toEqual([
    '["key","new"]',
  ]);
  expect(before!.writeScopes.reduce((size, bucket) => size + bucket.size, 0)).toBe(256);
  expect(receipts.readSqliteDatabaseScopedWriteTokenForPath(":memory:", "existing-0")).toBe(
    initial![0],
  );

  using database = new DatabaseSync(":memory:");
  receipts.retireSqliteDatabaseWriteScopes(database, ["new"]);
  expect(Atomics.load(delta!.writeScopes[0]!.get('["key","new"]')!.state, 1)).toBe(1);
  expect(registry.capture()[0]!.writeScopes.reduce((size, bucket) => size + bucket.size, 0)).toBe(
    257,
  );
  expect(receipts.readSqliteDatabaseScopedWriteTokenForPath(":memory:", "new")).not.toBe(added);
  expect(
    registry.capture(cursor)[0]!.writeScopes.flatMap((bucket) => Array.from(bucket.keys())),
  ).toEqual(['["key","new"]']);
});

it("sweeps remote retirements after keyed publication and imports new scope cells", () => {
  using database = new DatabaseSync(":memory:");
  const record = createAdmission();
  const references = new SharedArrayBuffer(8);
  Atomics.store(new Int32Array(references), 0, 1);
  record.references.set(0, references);
  const registry = new SqliteDatabaseAdmissionRegistry();
  registry.records.set(record.identity, record);
  const receipts = createReceipts(record, {
    publish: (current, keys) => registry.publish(current, keys),
  });
  receipts.readSqliteDatabaseScopedWriteTokenForPath(":memory:", "remote");
  const remote = { ...record, writeScopes: new Map(record.writeScopes) };
  createReceipts(remote, { publish: () => {} }).retireSqliteDatabaseWriteScopes(database, [
    "remote",
  ]);
  receipts.readSqliteDatabaseScopedWriteTokenForPath(":memory:", "local");
  registry.install([
    {
      ...record,
      facts: new Map(),
      writeScopes: [],
      references: new Map([[123, references]]),
    },
  ]);
  expect([...record.writeScopes.keys()]).toEqual(['["key","local"]']);
  expect(
    registry
      .capture(undefined, { admissions: [record] })[0]!
      .writeScopes.flatMap((bucket) => Array.from(bucket.keys())),
  ).toEqual(['["key","local"]']);
  const importer = { ...record, writeScopes: new Map() };
  createReceipts(importer, { publish: () => {} }).readSqliteDatabaseScopedWriteTokenForPath(
    ":memory:",
    "imported",
  );
  registry.install([{ ...importer, writeScopes: [importer.writeScopes] }]);
  expect(
    registry
      .capture(undefined, { admissions: [record] })[0]!
      .writeScopes.flatMap((bucket) => Array.from(bucket.keys()))
      .toSorted(),
  ).toEqual(['["key","imported"]', '["key","local"]']);
});
