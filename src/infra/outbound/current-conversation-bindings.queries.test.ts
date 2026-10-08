import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel-constants.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { createAccountScopedConversationBindingManager } from "./account-scoped-conversation-bindings.js";
import {
  deleteCurrentConversationBindingRecordsBySession,
  inspectCurrentConversationBindingRecords,
  listCurrentConversationBindingRecordsBySession,
  resolveCurrentConversationBindingRecord,
  updateCurrentConversationBindingRecord,
} from "./current-conversation-bindings.js";
import {
  inspectSessionBindingsByConversations,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "./session-binding-service.js";
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
      (sql.startsWith("select ") || sql.startsWith("with ")) &&
      sql.includes('"current_conversation_bindings"')
        ? "read"
        : null,
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
      for (let index = 0; index < 1_000; index += 1) {
        const record = records[index % records.length]!;
        const current = resolveCurrentConversationBindingRecord(record.conversation);
        expect(current).toEqual(record);
      }
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
    const inspect = () => inspectCurrentConversationBindingRecords([original.conversation])[0];
    expect(inspect()).toEqual(original);
    expect(inspect()).toEqual(original);
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
      expect(inspect()).toEqual(replacement);
      closeOpenClawStateDatabaseForTest();
      expect(openOpenClawStateDatabase().db === owned.db).toBe(false);
      expect(inspect()).toEqual(replacement);
      executeSqliteQuerySync(
        external,
        sql
          .deleteFrom("current_conversation_bindings")
          .where("binding_id", "=", original.bindingId),
      );
      expect(inspect()).toBeNull();
    } finally {
      external.close();
    }
  });
});

it("reuses unchanged binding rows while local updates, expiry, and returned objects stay current", async () => {
  await withOpenClawTestState({ label: "binding-selection-freshness" }, async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    const original = {
      ...binding("retained"),
      expiresAt: 150,
      metadata: { label: "original" },
    };
    const added = binding("missing");
    writeBinding(original);
    const { db } = openOpenClawStateDatabase();
    const executions = trackSqliteStatementExecutions(db, ["selection", "freshness"], (query) =>
      /^PRAGMA data_version$|FROM main\.pragma_data_version\(\)\s*$/iu.test(query)
        ? "freshness"
        : query.startsWith("with ") && query.includes('"current_conversation_bindings"')
          ? "selection"
          : null,
    );
    const refs = [original.conversation, added.conversation];
    const inspect = () => inspectCurrentConversationBindingRecords(refs);
    try {
      const selected = inspect();
      expect(selected).toEqual([original, null]);
      selected[0]!.targetSessionKey = "agent:other:consumer";
      selected[0]!.metadata!.label = "consumer";
      expect(inspect()).toEqual([original, null]);
      expect(inspect()).toEqual([original, null]);
      expect(executions.counts.selection).toBe(1);
      expect(executions.counts.freshness).toBe(3);

      const replacement = { ...original, targetSessionKey: "agent:other:replacement" };
      writeBinding(replacement);
      expect(inspect()).toEqual([replacement, null]);
      writeBinding(added);
      expect(inspect()).toEqual([replacement, added]);
      const readsBeforeExpiry = executions.counts.selection;
      clock.mockReturnValue(150);
      expect(inspect()).toEqual([null, added]);
      expect(executions.counts.selection).toBe(readsBeforeExpiry);
      expect(inspectCurrentConversationBindingRecords(refs.toReversed())).toEqual([added, null]);

      deleteCurrentConversationBindingRecordsBySession(added.targetSessionKey, undefined, false);
      expect(inspect()).toEqual([null, null]);
    } finally {
      executions.restore();
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
    const commonColumns = {
      target_session_key: "agent:main:bound",
      channel: "demo",
      account_id: "a",
      conversation_kind: "current",
      target_kind: "session",
      status: "active",
      bound_at: 1,
      expires_at: null,
      metadata_json: null,
      updated_at: now,
    };
    expect(readColumns(a.bindingId)).toEqual({
      ...commonColumns,
      binding_key: "demo\u241fa\u241f\u241fz-generic",
      binding_id: a.bindingId,
      parent_conversation_id: null,
      conversation_id: "z-generic",
      record_json: JSON.stringify(a),
    });
    const adapterColumns = {
      ...commonColumns,
      binding_key: "demo\u241fa\u241fparent\u241fa-adapter",
      binding_id: "fixture:a-adapter",
      parent_conversation_id: "parent",
      conversation_id: "a-adapter",
      record_json: JSON.stringify(b),
    };
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
      ...adapterColumns,
      target_session_key: "agent:other:retargeted",
      target_kind: "subagent",
      status: "ending",
      bound_at: 2,
      expires_at: changed.expiresAt,
      metadata_json: '{"version":"fresh"}',
      record_json: JSON.stringify(changed),
    });
    expect(listCurrentConversationBindingRecordsBySession(b.targetSessionKey, scoped)).toEqual([a]);
    expect(
      listCurrentConversationBindingRecordsBySession(changed.targetSessionKey, scoped),
    ).toEqual([changed]);
    expect(resolveCurrentConversationBindingRecord(b.conversation)).toEqual(changed);
    writeBinding(b);
    expect(readColumns()).toEqual(adapterColumns);
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

it("inspects mixed owner batches once without replacing exact rows by legacy fallbacks", async () => {
  await withOpenClawTestState({ label: "binding-batch-authority" }, async () => {
    const { db } = openOpenClawStateDatabase();
    const sql = getNodeSqliteKysely<Pick<DB, "current_conversation_bindings">>(db);
    const value = (id: string): SessionBindingRecord => ({
      ...binding(id),
      bindingId: `generic:${INTERNAL_MESSAGE_CHANNEL}␟default␟␟${id}`,
      conversation: { channel: INTERNAL_MESSAGE_CHANNEL, accountId: "default", conversationId: id },
    });
    const seed = (record: SessionBindingRecord, parent?: string, malformed = false) => {
      const conversation = {
        ...record.conversation,
        ...(parent ? { parentConversationId: parent } : {}),
      };
      // Seed physical legacy and malformed rows outside the normalizing writer.
      executeSqliteQuerySync(
        db,
        sql.insertInto("current_conversation_bindings").values({
          binding_key: [
            conversation.channel,
            conversation.accountId,
            parent ?? "",
            conversation.conversationId,
          ].join("␟"),
          binding_id: record.bindingId,
          target_session_key: record.targetSessionKey,
          channel: conversation.channel,
          account_id: conversation.accountId,
          conversation_kind: "current",
          parent_conversation_id: parent ?? null,
          conversation_id: conversation.conversationId,
          target_kind: record.targetKind,
          status: record.status,
          bound_at: record.boundAt,
          expires_at: record.expiresAt ?? null,
          metadata_json: record.metadata ? JSON.stringify(record.metadata) : null,
          record_json: malformed ? "{" : JSON.stringify({ ...record, conversation }),
          updated_at: Date.now(),
        }),
      );
    };
    const exact = value("exact"),
      legacy = value("legacy"),
      malformed = value("malformed"),
      expired = value("expired");
    seed(exact);
    seed(legacy, " legacy ", true);
    seed(legacy, "legacy");
    seed(malformed, undefined, true);
    seed(malformed, "malformed");
    seed({ ...expired, expiresAt: 1 });
    seed(expired, "expired");
    const manager = createAccountScopedConversationBindingManager({
      channel: "fixture",
      accountId: "owner",
      cfg: {},
      stateKey: Symbol("batch-owner"),
      toStoredTargetKind: (kind) => kind,
      toSessionBindingTargetKind: (kind) => kind,
    });
    const account = {
      ...binding("account", "owner"),
      bindingId: "owner:account",
      conversation: { channel: "fixture", accountId: "owner", conversationId: "account" },
    };
    seed(account);
    const external = {
      ...value("external"),
      bindingId: "external-owned",
      conversation: { channel: "external", accountId: "default", conversationId: "room" },
    };
    const adapter = {
      channel: "external",
      accountId: "default",
      listBySession: () => [external],
      resolveByConversation: () => external,
    };
    registerSessionBindingAdapter(adapter);
    const executions = trackSqliteStatementExecutions(db, ["selection"], (query) =>
      query.startsWith("with ") && query.includes('"current_conversation_bindings"')
        ? "selection"
        : null,
    );
    try {
      const refs = [
        exact,
        value("missing"),
        legacy,
        malformed,
        expired,
        account,
        external,
        exact,
      ].map((record) => record.conversation);
      const selected = inspectSessionBindingsByConversations(refs);
      expect(
        selected.map((item) =>
          item.status === "available" ? (item.binding?.bindingId ?? null) : item.status,
        ),
      ).toEqual([
        exact.bindingId,
        null,
        legacy.bindingId,
        null,
        null,
        account.bindingId,
        external.bindingId,
        exact.bindingId,
      ]);
      expect(executions.counts.selection).toBe(1);
    } finally {
      executions.restore();
      unregisterSessionBindingAdapter({ ...adapter, adapter });
      manager.stop();
    }
  });
});
