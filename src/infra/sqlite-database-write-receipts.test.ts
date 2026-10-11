import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  SqliteDatabaseGenerationSlot,
  type Admission,
} from "./sqlite-database-admission-record.js";
import { createSqliteDatabaseWriteReceipts } from "./sqlite-database-write-receipts.js";

it("invalidates a scope registered by another isolate during an accepted write", () => {
  const reader = new DatabaseSync(":memory:");
  const writer = new DatabaseSync(":memory:");
  const host: Admission = {
    identity: "receipt-test",
    location: ":memory:",
    descriptor: -1,
    descriptorOwner: 0,
    generationId: "receipt-test",
    generation: new SharedArrayBuffer(
      Int32Array.BYTES_PER_ELEMENT * Object.keys(SqliteDatabaseGenerationSlot).length,
    ),
    facts: new Map(),
    writeScopes: new Map(),
  };
  const worker = { ...host, writeScopes: new Map(host.writeScopes) };
  const receipts = createSqliteDatabaseWriteReceipts({
    admission: (database) => (database === reader ? host : worker),
    pathAdmission: () => host,
    readRevision: () => 0,
    writer: () => worker,
    suspended: () => false,
    exchange: () => {},
    publish: (record) => {
      Atomics.store(
        new Int32Array(record.generation),
        SqliteDatabaseGenerationSlot.writeScopeCount,
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
