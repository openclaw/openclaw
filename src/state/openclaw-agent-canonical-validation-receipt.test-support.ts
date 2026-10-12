import assert from "node:assert/strict";
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
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";

assert.equal(isMainThread, true, "Physical admission facts require the real host owner");
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
