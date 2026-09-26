import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import {
  deleteCurrentConversationBindingRecordsBySession,
  listCurrentConversationBindingRecordsBySession,
  resolveCurrentConversationBindingRecord,
  updateCurrentConversationBindingRecord,
} from "./current-conversation-bindings.js";
import type { SessionBindingRecord } from "./session-binding.types.js";

afterEach(() => vi.restoreAllMocks());

function binding(id: string, accountId = "default", generic = false): SessionBindingRecord {
  const conversation = { channel: "demo", accountId, conversationId: id };
  return {
    bindingId: generic ? `generic:demo\u241f${accountId}\u241f\u241f${id}` : `fixture:${id}`,
    conversation,
    targetSessionKey: "agent:main:bound",
    targetKind: "session",
    status: "active",
    boundAt: 1,
  };
}

function writeBinding(record: SessionBindingRecord) {
  return updateCurrentConversationBindingRecord(record.conversation, () => record).current;
}

it("reads current bindings without recompiling fixed queries after warmup", async () => {
  await withOpenClawTestState({ label: "binding-query-budget" }, async () => {
    const { db } = openOpenClawStateDatabase();
    const executions = trackSqliteStatementExecutions(db, ["read"], (sql) =>
      sql.startsWith("select ") && sql.includes('"current_conversation_bindings"') ? "read" : null,
    );
    const compile = vi.spyOn(getNodeSqliteKysely(db).getExecutor(), "compileQuery");
    try {
      const records = [binding("one"), binding("two", "sibling")];
      for (const record of records) {
        expect(writeBinding(record)).toEqual(record);
        expect(resolveCurrentConversationBindingRecord(record.conversation)).toEqual(record);
      }
      compile.mockClear();
      executions.counts.read = 0;
      let matched = 0;
      for (let index = 0; index < 1_000; index += 1) {
        const record = records[index % records.length]!;
        const current = resolveCurrentConversationBindingRecord(record.conversation);
        expect(current).toEqual(record);
        matched += 1;
      }
      expect(matched).toBe(1_000);
      expect(executions.counts.read).toBe(1_000);
      expect(
        compile.mock.results.filter(
          (result) =>
            result.type === "return" &&
            result.value.sql.includes('"current_conversation_bindings"'),
        ).length,
      ).toBe(0);
    } finally {
      executions.restore();
    }
  });
});

it("observes another SQLite connection after warm reads and database reopen", async () => {
  await withOpenClawTestState({ label: "binding-query-freshness" }, async () => {
    const original = binding("external");
    writeBinding(original);
    expect(resolveCurrentConversationBindingRecord(original.conversation)).toEqual(original);
    const owned = openOpenClawStateDatabase();
    const external = new DatabaseSync(owned.path);
    try {
      const sql = getNodeSqliteKysely<Pick<DB, "current_conversation_bindings">>(external);
      const replacement = {
        ...original,
        targetSessionKey: "agent:other:replacement",
        metadata: { opaque: { fresh: [1, 2] } },
      };
      executeSqliteQuerySync(
        external,
        sql
          .updateTable("current_conversation_bindings")
          .set({
            target_session_key: replacement.targetSessionKey,
            record_json: JSON.stringify(replacement),
            metadata_json: JSON.stringify(replacement.metadata),
          })
          .where("binding_id", "=", original.bindingId),
      );
      expect(resolveCurrentConversationBindingRecord(original.conversation)).toEqual(replacement);
      closeOpenClawStateDatabaseForTest();
      expect(openOpenClawStateDatabase().db === owned.db).toBe(false);
      expect(resolveCurrentConversationBindingRecord(original.conversation)).toEqual(replacement);
      executeSqliteQuerySync(
        external,
        sql
          .deleteFrom("current_conversation_bindings")
          .where("binding_id", "=", original.bindingId),
      );
      expect(resolveCurrentConversationBindingRecord(original.conversation)).toBeNull();
    } finally {
      external.close();
    }
  });
});

it("binds fresh upsert fields and preserves every scoped and generic list shape", async () => {
  await withOpenClawTestState({ label: "binding-query-scopes" }, async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const a = binding("z-generic", "a", true);
    const b = binding("a-adapter", "a");
    b.conversation.parentConversationId = "parent";
    const c = binding("other-generic", "b", true);
    const unrelated = {
      ...binding("different-target", "a"),
      targetSessionKey: "agent:other:bound",
    };
    for (const record of [a, b, c, unrelated]) {
      writeBinding(record);
    }
    const scoped = { channel: "demo", accountId: "a" };
    expect(listCurrentConversationBindingRecordsBySession(a.targetSessionKey)).toEqual([a, c]);
    expect(listCurrentConversationBindingRecordsBySession(a.targetSessionKey, scoped)).toEqual([
      b,
      a,
    ]);

    const { db } = openOpenClawStateDatabase();
    const sql = getNodeSqliteKysely<Pick<DB, "current_conversation_bindings">>(db);
    const readColumns = (bindingId = b.bindingId) =>
      executeSqliteQuerySync(
        db,
        sql
          .selectFrom("current_conversation_bindings")
          .selectAll()
          .where("binding_id", "=", bindingId),
      ).rows[0];
    expect(readColumns(a.bindingId)).toEqual({
      binding_key: "demo\u241fa\u241f\u241fz-generic",
      binding_id: a.bindingId,
      target_session_key: "agent:main:bound",
      channel: "demo",
      account_id: "a",
      conversation_kind: "current",
      parent_conversation_id: null,
      conversation_id: "z-generic",
      target_kind: "session",
      status: "active",
      bound_at: 1,
      expires_at: null,
      metadata_json: null,
      record_json: JSON.stringify(a),
      updated_at: now,
    });
    const changed: SessionBindingRecord = {
      ...b,
      targetSessionKey: "agent:other:retargeted",
      targetKind: "subagent",
      status: "ending",
      boundAt: 2,
      expiresAt: Date.now() + 60_000,
      metadata: { version: "fresh" },
    };
    writeBinding(changed);
    expect(readColumns()).toEqual({
      binding_key: "demo\u241fa\u241fparent\u241fa-adapter",
      binding_id: "fixture:a-adapter",
      target_session_key: "agent:other:retargeted",
      channel: "demo",
      account_id: "a",
      conversation_kind: "current",
      parent_conversation_id: "parent",
      conversation_id: "a-adapter",
      target_kind: "subagent",
      status: "ending",
      bound_at: 2,
      expires_at: changed.expiresAt,
      metadata_json: '{"version":"fresh"}',
      record_json: JSON.stringify(changed),
      updated_at: now,
    });
    expect(listCurrentConversationBindingRecordsBySession(b.targetSessionKey, scoped)).toEqual([a]);
    expect(
      listCurrentConversationBindingRecordsBySession(changed.targetSessionKey, scoped),
    ).toEqual([changed]);
    expect(resolveCurrentConversationBindingRecord(b.conversation)).toEqual(changed);
    writeBinding(b);
    expect(readColumns()).toEqual({
      binding_key: "demo\u241fa\u241fparent\u241fa-adapter",
      binding_id: "fixture:a-adapter",
      target_session_key: "agent:main:bound",
      channel: "demo",
      account_id: "a",
      conversation_kind: "current",
      parent_conversation_id: "parent",
      conversation_id: "a-adapter",
      target_kind: "session",
      status: "active",
      bound_at: 1,
      expires_at: null,
      metadata_json: null,
      record_json: JSON.stringify(b),
      updated_at: now,
    });
    expect(resolveCurrentConversationBindingRecord(b.conversation)).toEqual(b);

    expect(
      deleteCurrentConversationBindingRecordsBySession(a.targetSessionKey, scoped, true),
    ).toEqual([a]);
    expect(resolveCurrentConversationBindingRecord(b.conversation)).toEqual(b);
    expect(resolveCurrentConversationBindingRecord(c.conversation)).toEqual(c);
    expect(
      deleteCurrentConversationBindingRecordsBySession(a.targetSessionKey, undefined, false),
    ).toEqual([b, c]);
    expect(resolveCurrentConversationBindingRecord(unrelated.conversation)).toEqual(unrelated);
  });
});

it("preserves the committed row when a metadata update cannot be serialized", async () => {
  await withOpenClawTestState({ label: "binding-query-serialization-failure" }, async () => {
    const original = binding("cyclic-metadata");
    writeBinding(original);
    const { db } = openOpenClawStateDatabase();
    const sql = getNodeSqliteKysely<Pick<DB, "current_conversation_bindings">>(db);
    const readRow = () =>
      executeSqliteQuerySync(
        db,
        sql
          .selectFrom("current_conversation_bindings")
          .selectAll()
          .where("binding_id", "=", original.bindingId),
      ).rows[0];
    const before = readRow();
    expect(before).toBeDefined();
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;
    expect(() =>
      updateCurrentConversationBindingRecord(original.conversation, () => ({
        ...original,
        targetSessionKey: "agent:other:rejected",
        metadata,
      })),
    ).toThrow(TypeError);
    expect(readRow()).toEqual(before);
    expect(resolveCurrentConversationBindingRecord(original.conversation)).toEqual(original);
  });
});
