import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  SqliteDatabaseGenerationSlot,
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
    facts: new Map(),
    writeScopes: new Map(),
    writeScopeRevision: 0,
    references: new Map(),
  };
}

it("publishes cohort scope discovery once and preserves independent write receipts", () => {
  const database = new DatabaseSync(":memory:");
  const record = createAdmission();
  const publications: number[] = [];
  const receipts = createSqliteDatabaseWriteReceipts({
    admission: () => record,
    pathAdmission: () => record,
    readRevision: () => 0,
    writer: () => record,
    suspended: () => false,
    publish: (current) => {
      Atomics.store(
        new Int32Array(current.generation),
        SqliteDatabaseGenerationSlot.writeScopeRevision,
        current.writeScopes.size,
      );
      current.writeScopeRevision = readSqliteDatabaseGeneration(current, "writeScopeRevision");
      publications.push(current.writeScopes.size);
    },
  });
  const scopes = [
    ["first", sqliteSessionIdWriteScope("first-id")],
    ["second", sqliteSessionIdWriteScope("second-id")],
  ];
  try {
    const before = receipts.readSqliteDatabaseScopedWriteTokensForPath(":memory:", scopes)!;
    expect(before).toHaveLength(2);
    expect(before.every((token) => typeof token === "string")).toBe(true);
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
  } finally {
    database.close();
  }
});

it("invalidates a scope registered by another isolate during an accepted write", () => {
  const reader = new DatabaseSync(":memory:");
  const writer = new DatabaseSync(":memory:");
  const host = createAdmission();
  const worker = { ...host, writeScopes: new Map(host.writeScopes) };
  const receipts = createSqliteDatabaseWriteReceipts({
    admission: (database) => (database === reader ? host : worker),
    pathAdmission: () => host,
    readRevision: () => 0,
    writer: () => worker,
    suspended: () => false,
    publish: (record) => {
      Atomics.store(
        new Int32Array(record.generation),
        SqliteDatabaseGenerationSlot.writeScopeRevision,
        record.writeScopes.size,
      );
    },
  });
  try {
    receipts.readSqliteDatabaseScopedWriteToken(reader, "existing");
    worker.writeScopes = new Map(host.writeScopes);
    let before: string | undefined;
    receipts.withSqliteDatabaseWriteScope(writer, ["late"], () => {
      receipts.begin(writer, false);
      before = receipts.readSqliteDatabaseScopedWriteToken(reader, "late");
      receipts.finish(writer, worker);
    });
    expect(before).toBeTypeOf("string");
    expect(receipts.readSqliteDatabaseScopedWriteToken(reader, "late")).not.toBe(before);
  } finally {
    reader.close();
    writer.close();
  }
});
