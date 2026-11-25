import assert from "node:assert/strict";
import { statSync } from "node:fs";
import type { StatementSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { sqlPublicationAnchor } from "../infra/sql-connection.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  clearPersistedOpenClawAgentCanonicalValidation as clearReceipt,
  hasPersistedOpenClawAgentCanonicalValidation as hasReceipt,
  loadOpenClawAgentCanonicalValidationReceipt as loadReceipt,
  recordOpenClawAgentCanonicalValidation as recordReceipt,
} from "./openclaw-agent-canonical-validation-receipt.js";
import { openOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly-open.js";
import { AGENT_SCHEMA_COMPATIBILITY } from "./openclaw-agent-db-schema-compatibility.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction as writeTransaction,
} from "./openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

assert.equal(isMainThread, true, "Physical admission facts require the real host owner");
for (const legacy of ["legacy-birthtime", "missing-column"] as const) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    const original = openOpenClawAgentDatabase(options);
    if (legacy === "missing-column") {
      original.db.exec("ALTER TABLE session_key_contract DROP COLUMN canonical_ready");
      closeOpenClawAgentDatabaseByPath(original.path);
    }
    const database = openOpenClawAgentDatabase(options);
    const version = database.db.prepare("PRAGMA user_version").get();
    const schema = database.db.prepare("PRAGMA schema_version").get();
    if (legacy === "legacy-birthtime") {
      const file = statSync(database.path, { bigint: true });
      const birthtime = file.birthtimeNs.toString();
      database.db
        .prepare("UPDATE session_key_contract SET canonical_ready = ? WHERE id = 1")
        .run(JSON.stringify([1, "main", `${file.dev}:${file.ino}`, birthtime]));
      assert.equal(loadReceipt(database), process.platform !== "linux" || birthtime === "0");
    } else {
      assert.equal(hasReceipt(database), false);
      assert.throws(
        () =>
          writeTransaction((current) => {
            recordReceipt(current);
            throw new Error("rollback first receipt");
          }, options),
        /rollback first receipt/u,
      );
      assert.deepEqual(database.db.prepare("PRAGMA schema_version").get(), schema);
      assert.equal(hasReceipt(database), false);
    }
    writeTransaction(recordReceipt, options);
    assert.equal(hasReceipt(database), true);
    if (legacy === "missing-column") {
      const column = database.db
        .prepare("PRAGMA table_info(session_key_contract)")
        .all()
        .find((entry) => entry.name === "canonical_ready");
      assert.deepEqual(
        [column?.type, column?.notnull, column?.dflt_value, column?.pk],
        ["TEXT", 0, null, 0],
      );
      const previousSchema = OPENCLAW_AGENT_SCHEMA_SQL.replace(/^\s*canonical_ready TEXT,\n/mu, "");
      assertSqliteSchemaContains(
        sqlPublicationAnchor(database.db),
        database.path,
        previousSchema,
        AGENT_SCHEMA_COMPATIBILITY,
      );
      const completeSchema = database.db.prepare("PRAGMA schema_version").get();
      writeTransaction(recordReceipt, options);
      assert.deepEqual(database.db.prepare("PRAGMA schema_version").get(), completeSchema);
    } else {
      assert.deepEqual(database.db.prepare("PRAGMA schema_version").get(), schema);
    }
    assert.deepEqual(database.db.prepare("PRAGMA user_version").get(), version);
  });
}
await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
  const options = { agentId: "main", env };
  openOpenClawAgentDatabase(options);
  writeTransaction(recordReceipt, options);
  const opened = openOpenClawAgentDatabaseReadOnly(options);
  assert.ok(opened.found);
  const reader = opened.database;
  const canonicalReady = reader.db
    .prepare("SELECT canonical_ready FROM session_key_contract WHERE id = 1")
    .get()?.canonical_ready;
  assert.ok(typeof canonicalReady === "string");
  const observation = { canonicalReady };
  const prototype = requireNodeSqlite().StatementSync.prototype;
  // oxlint-disable-next-line typescript/unbound-method -- The proxy forwards the native receiver with Reflect.apply.
  const original = { get: prototype.get, all: prototype.all, iterate: prototype.iterate };
  let receiptReads = 0;
  type Read = (typeof original)[keyof typeof original];
  const observe = <T extends Read>(read: T): T =>
    new Proxy(read, {
      apply(target, receiver: StatementSync, args) {
        assert.doesNotMatch(receiver.sourceSQL, /^PRAGMA table_info\(session_key_contract\)/iu);
        receiptReads += Number(/^select "canonical_ready" /iu.test(receiver.sourceSQL));
        return Reflect.apply(target, receiver, args);
      },
    });
  prototype.get = observe(original.get);
  prototype.all = observe(original.all);
  prototype.iterate = observe(original.iterate);
  try {
    assert.equal(hasReceipt(reader), true);
    writeTransaction(
      (database) =>
        writeSessionEntry(database, "agent:main:receipt-proof", {
          sessionId: "receipt-proof",
          updatedAt: 1,
        }),
      options,
    );
    assert.deepEqual([hasReceipt(reader), receiptReads], [true, 0]);
    assert.throws(
      () =>
        writeTransaction((current) => {
          clearReceipt(current);
          throw new Error("rollback repair");
        }, options),
      /rollback repair/u,
    );
    // A rollback may expire facts; runtime lookup stays SQL-free until the admission owner reloads.
    const readsBeforeMiss = receiptReads;
    hasReceipt(reader);
    assert.equal(receiptReads, readsBeforeMiss);
    assert.equal(loadReceipt(reader, observation), true);
    assert.equal(receiptReads, readsBeforeMiss);
    assert.equal(hasReceipt(reader), true);
    const readsAfterRollback = receiptReads;
    writeTransaction(clearReceipt, options);
    assert.equal(hasReceipt(reader), false);
    assert.equal(loadReceipt(reader, observation), false);
    writeTransaction(recordReceipt, options);
    assert.equal(loadReceipt(reader, { canonicalReady: null }), true);
    assert.deepEqual([hasReceipt(reader), receiptReads], [true, readsAfterRollback]);
  } finally {
    Object.assign(prototype, original);
    reader.close();
  }
});
