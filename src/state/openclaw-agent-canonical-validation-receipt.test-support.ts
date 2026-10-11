import assert from "node:assert/strict";
import type { StatementSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  clearPersistedOpenClawAgentCanonicalValidation,
  hasPersistedOpenClawAgentCanonicalValidation,
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
  let receiptReads = 0;
  const observe = <Method extends "get" | "all" | "iterate">(method: Method) => {
    const original = prototype[method];
    prototype[method] = new Proxy(original, {
      apply(target, receiver: StatementSync, args) {
        assert.doesNotMatch(receiver.sourceSQL, /^PRAGMA table_info\(session_key_contract\)/iu);
        if (/^select "canonical_ready" /iu.test(receiver.sourceSQL)) {
          receiptReads += 1;
        }
        return Reflect.apply(target, receiver, args);
      },
    });
    return () => {
      prototype[method] = original;
    };
  };
  const restore = (["get", "all", "iterate"] as const).map(observe);
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
    // Native rollback may conservatively expire prior admission facts.
    assert.equal(hasPersistedOpenClawAgentCanonicalValidation(reader), true);
    const readsAfterRollback = receiptReads;
    runOpenClawAgentWriteTransaction(clearPersistedOpenClawAgentCanonicalValidation, options);
    assert.equal(hasPersistedOpenClawAgentCanonicalValidation(reader), false);
    runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
    assert.equal(hasPersistedOpenClawAgentCanonicalValidation(reader), true);
    assert.equal(receiptReads, readsAfterRollback);
  } finally {
    restore.forEach((restoreRead) => restoreRead());
    reader.close();
  }
});
