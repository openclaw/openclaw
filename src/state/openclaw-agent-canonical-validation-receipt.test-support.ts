import assert from "node:assert/strict";
import { statSync } from "node:fs";
import type { StatementSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  clearPersistedOpenClawAgentCanonicalValidation,
  hasPersistedOpenClawAgentCanonicalValidation,
  loadOpenClawAgentCanonicalValidationReceipt,
  recordOpenClawAgentCanonicalValidation,
} from "./openclaw-agent-canonical-validation-receipt.js";
import { openOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly-open.js";
import { assertOpenClawAgentSchemaContains } from "./openclaw-agent-db-schema-helpers.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

assert.equal(isMainThread, true, "Physical admission facts require the real host owner");
for (const legacy of ["legacy-birthtime", "missing-column"] as const) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    const original = openOpenClawAgentDatabase(options);
    if (legacy === "missing-column") {
      closeOpenClawAgentDatabaseByPath(original.path);
      using old = new (requireNodeSqlite().DatabaseSync)(original.path);
      old.exec("ALTER TABLE session_key_contract DROP COLUMN canonical_ready");
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
      assert.equal(
        loadOpenClawAgentCanonicalValidationReceipt(database),
        process.platform !== "linux" || birthtime === "0",
      );
    } else {
      assert.equal(hasPersistedOpenClawAgentCanonicalValidation(database), false);
      assert.throws(
        () =>
          runOpenClawAgentWriteTransaction((current) => {
            recordOpenClawAgentCanonicalValidation(current);
            throw new Error("rollback first receipt");
          }, options),
        /rollback first receipt/u,
      );
      assert.deepEqual(database.db.prepare("PRAGMA schema_version").get(), schema);
      assert.equal(hasPersistedOpenClawAgentCanonicalValidation(database), false);
    }
    runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
    assert.equal(hasPersistedOpenClawAgentCanonicalValidation(database), true);
    if (legacy === "missing-column") {
      const column = database.db
        .prepare("PRAGMA table_info(session_key_contract)")
        .all()
        .find((entry) => entry.name === "canonical_ready");
      assert.equal(column?.type, "TEXT");
      assert.equal(column?.notnull, 0);
      assert.equal(column?.dflt_value, null);
      assert.equal(column?.pk, 0);
      const previousSchema = OPENCLAW_AGENT_SCHEMA_SQL.replace(/^\s*canonical_ready TEXT,\n/mu, "");
      assert.doesNotThrow(() =>
        assertOpenClawAgentSchemaContains(database.db, database.path, previousSchema),
      );
      const completeSchema = database.db.prepare("PRAGMA schema_version").get();
      runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
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
  runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
  const opened = openOpenClawAgentDatabaseReadOnly(options);
  assert.equal(opened.found, true);
  if (!opened.found) {
    return;
  }
  const reader = opened.database;
  const prototype = requireNodeSqlite().StatementSync.prototype;
  // oxlint-disable-next-line typescript/unbound-method -- The proxy forwards the native receiver with Reflect.apply.
  const original = { get: prototype.get, all: prototype.all, iterate: prototype.iterate };
  let receiptReads = 0;
  const observe = <
    Read extends StatementSync["get"] | StatementSync["all"] | StatementSync["iterate"],
  >(
    read: Read,
  ): Read =>
    new Proxy(read, {
      apply(target, receiver: StatementSync, args) {
        assert.doesNotMatch(receiver.sourceSQL, /^PRAGMA table_info\(session_key_contract\)/iu);
        if (/^select "canonical_ready" /iu.test(receiver.sourceSQL)) {
          receiptReads += 1;
        }
        return Reflect.apply(target, receiver, args);
      },
    });
  prototype.get = observe(original.get);
  prototype.all = observe(original.all);
  prototype.iterate = observe(original.iterate);
  try {
    assert.equal(hasPersistedOpenClawAgentCanonicalValidation(reader), true);
    runOpenClawAgentWriteTransaction(
      (database) =>
        writeSessionEntry(database, "agent:main:receipt-proof", {
          sessionId: "receipt-proof",
          updatedAt: 1,
        }),
      options,
    );
    assert.equal(hasPersistedOpenClawAgentCanonicalValidation(reader), true);
    assert.equal(receiptReads, 0);
    assert.throws(
      () =>
        runOpenClawAgentWriteTransaction((current) => {
          clearPersistedOpenClawAgentCanonicalValidation(current);
          throw new Error("rollback repair");
        }, options),
      /rollback repair/u,
    );
    // A rollback may expire facts; runtime lookup stays SQL-free until the admission owner reloads.
    const readsBeforeMiss = receiptReads;
    hasPersistedOpenClawAgentCanonicalValidation(reader);
    assert.equal(receiptReads, readsBeforeMiss);
    assert.equal(loadOpenClawAgentCanonicalValidationReceipt(reader), true);
    assert.equal(hasPersistedOpenClawAgentCanonicalValidation(reader), true);
    const readsAfterRollback = receiptReads;
    runOpenClawAgentWriteTransaction(clearPersistedOpenClawAgentCanonicalValidation, options);
    assert.equal(hasPersistedOpenClawAgentCanonicalValidation(reader), false);
    runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
    assert.equal(hasPersistedOpenClawAgentCanonicalValidation(reader), true);
    assert.equal(receiptReads, readsAfterRollback);
  } finally {
    prototype.get = original.get;
    prototype.all = original.all;
    prototype.iterate = original.iterate;
    reader.close();
  }
});
