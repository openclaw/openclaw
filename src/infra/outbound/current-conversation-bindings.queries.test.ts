import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import {
  bindCurrentConversationRecordAsync,
  deleteCurrentConversationBindingRecordsBySession,
  inspectCurrentConversationBindingRecords,
  listCurrentConversationBindingRecordsBySession,
  resolveCurrentConversationBindingRecord,
  removeCurrentConversationBindingsAsync,
  updateCurrentConversationBindingRecord,
} from "./current-conversation-bindings.js";
import {
  readCurrentConversationBindingListsInDatabase,
  readCurrentConversationBindingSelectionInDatabase,
} from "./current-conversation-bindings.kernel.js";
import { currentConversationBindingPublication } from "./current-conversation-bindings.publication.js";
import type { SessionBindingRecord } from "./session-binding.types.js";

type CurrentConversationBindingPublication = Parameters<
  Parameters<typeof currentConversationBindingPublication.subscribe>[0]
>[0];

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

it("reads ordered binding selections and target batches in one statement after committed writes", async () => {
  await withOpenClawTestState({ label: "binding-single-statement-selection" }, async () => {
    const original = binding("current");
    const missing = binding("missing");
    writeBinding(original);
    const { db } = openOpenClawStateDatabase();
    const statements = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(db),
      ["statement"],
      () => "statement",
    );
    const refs = [missing.conversation, original.conversation, original.conversation];
    try {
      expect(readCurrentConversationBindingSelectionInDatabase(db, refs)).toEqual([
        null,
        original,
        original,
      ]);
      expect(statements.counts.statement).toBe(1);
      const replacement = { ...original, targetSessionKey: "agent:other:replacement" };
      writeBinding(replacement);
      const before = statements.counts.statement;
      expect(readCurrentConversationBindingSelectionInDatabase(db, refs)).toEqual([
        null,
        replacement,
        replacement,
      ]);
      expect(statements.counts.statement - before).toBe(1);
      writeBinding(missing);
      const listBefore = statements.counts.statement;
      const targets = [
        replacement.targetSessionKey,
        missing.targetSessionKey,
        replacement.targetSessionKey,
      ];
      expect(
        readCurrentConversationBindingListsInDatabase(db, targets, {
          channel: "demo",
          accountId: "default",
        }).map((list) => list.records),
      ).toEqual([[replacement], [missing], [replacement]]);
      expect(statements.counts.statement - listBefore).toBe(1);
      expect(readCurrentConversationBindingListsInDatabase(db, targets)).toEqual(
        targets.map(() => ({ records: [], requiresPrune: false })),
      );
    } finally {
      statements.restore();
    }
  });
});

it("invalidates warm main-thread binding rows after worker receipts and database reopen", async () => {
  await withOpenClawTestState({ label: "binding-query-freshness" }, async () => {
    const original = binding("worker-written");
    writeBinding(original);
    const inspect = () => inspectCurrentConversationBindingRecords([original.conversation])[0];
    expect(inspect()).toEqual(original);
    expect(inspect()).toEqual(original);
    const owned = openOpenClawStateDatabase();
    const executions = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(owned.db),
      ["freshness"],
      (query) =>
        /^PRAGMA data_version$|FROM main\.pragma_data_version\(\)\s*$/iu.test(query)
          ? "freshness"
          : null,
    );
    try {
      const replacement = {
        ...original,
        targetSessionKey: "agent:other:replacement",
        metadata: { opaque: { fresh: [1, 2] } },
      };
      expect(await bindCurrentConversationRecordAsync({ record: replacement })).toEqual(
        replacement,
      );
      expect(inspect()).toEqual(replacement);
      expect(executions.counts.freshness).toBe(0);
      await closeOpenClawStateDatabaseAsync();
      expect(openOpenClawStateDatabase().db === owned.db).toBe(false);
      expect(inspect()).toEqual(replacement);
      expect(
        await removeCurrentConversationBindingsAsync({ conversation: original.conversation }),
      ).toEqual([replacement]);
      expect(inspect()).toBeNull();
    } finally {
      executions.restore();
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
    const executions = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(db),
      ["selection", "freshness"],
      (query) =>
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
      expect(executions.counts.freshness).toBe(0);

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

it("installs every native binding fact before observers and discards nested rollback", async () => {
  await withOpenClawTestState({ label: "binding-native-receipts" }, async () => {
    const first = binding("receipt-one", "default", true);
    const second = binding("receipt-two", "default", true);
    const discarded = binding("receipt-rollback", "default", true);
    const facts = new Map<string, string>();
    const observedFacts: string[][] = [];
    const publications: CurrentConversationBindingPublication[] = [];
    const unsubscribeFacts = currentConversationBindingPublication.subscribeFacts((change) => {
      if (!("receipt" in change)) {
        return;
      }
      const { receipt } = change;
      for (const [key, fact] of receipt.facts) {
        if (fact.kind === "postimage") {
          facts.set(key, fact.value.targetSessionKey);
        } else {
          facts.delete(key);
        }
      }
    });
    const unsubscribe = currentConversationBindingPublication.subscribe((publication) => {
      publications.push(publication);
      observedFacts.push([...facts.values()]);
    });
    try {
      runOpenClawStateWriteTransaction(() => {
        writeBinding(first);
        expect(facts.size).toBe(0);
        expect(() =>
          runOpenClawStateWriteTransaction(() => {
            writeBinding(discarded);
            throw new Error("rollback nested binding");
          }),
        ).toThrow("rollback nested binding");
        writeBinding(second);
        expect(facts.size).toBe(0);
      });
      expect(publications).toHaveLength(2);
      expect(observedFacts).toEqual([
        [first.targetSessionKey, second.targetSessionKey],
        [first.targetSessionKey, second.targetSessionKey],
      ]);
      expect(publications.every(({ receipt }) => typeof receipt.source.identity === "string")).toBe(
        true,
      );
      expect(resolveCurrentConversationBindingRecord(discarded.conversation)).toBeNull();
      expect(() =>
        runOpenClawStateWriteTransaction(() => {
          writeBinding(discarded);
          throw new Error("rollback outer binding");
        }),
      ).toThrow("rollback outer binding");
      expect(publications).toHaveLength(2);
    } finally {
      unsubscribeFacts();
      unsubscribe();
    }
  });
});

it("publishes rebind, legacy repair, expiry and scoped deletion reverse-index invalidations", async () => {
  await withOpenClawTestState({ label: "binding-reverse-receipts" }, async () => {
    const original = binding("receipt-rebind", "default", true);
    const sibling = binding("receipt-sibling", "other", true);
    writeBinding(original);
    writeBinding(sibling);
    const publications: CurrentConversationBindingPublication[] = [];
    const unsubscribe = currentConversationBindingPublication.subscribe((publication) =>
      publications.push(publication),
    );
    try {
      const rebound = { ...original, targetSessionKey: "agent:main:replacement" };
      writeBinding(rebound);
      expect(publications.at(-1)?.sessionKeys).toEqual([
        original.targetSessionKey,
        rebound.targetSessionKey,
      ]);
      const { db } = openOpenClawStateDatabase();
      db.prepare(
        "UPDATE current_conversation_bindings SET binding_key = ? WHERE binding_id = ?",
      ).run("old-receipt-key", original.bindingId);
      expect(resolveCurrentConversationBindingRecord(original.conversation)).toEqual(rebound);
      const repaired = publications.at(-1)!;
      expect(repaired.receipt.facts.get("old-receipt-key")).toEqual({ kind: "absent" });
      expect([...repaired.receipt.facts.values()]).toContainEqual({
        kind: "postimage",
        value: rebound,
      });
      writeBinding({ ...rebound, expiresAt: 1 });
      expect(listCurrentConversationBindingRecordsBySession(rebound.targetSessionKey)).toEqual([]);
      expect([...publications.at(-1)!.receipt.facts.values()]).toEqual([{ kind: "absent" }]);
      expect(publications.at(-1)?.sessionKeys).toEqual([rebound.targetSessionKey]);
      expect(
        deleteCurrentConversationBindingRecordsBySession(
          sibling.targetSessionKey,
          original.conversation,
        ),
      ).toEqual([]);
      expect(resolveCurrentConversationBindingRecord(sibling.conversation)).toEqual(sibling);
      expect(
        deleteCurrentConversationBindingRecordsBySession(
          sibling.targetSessionKey,
          sibling.conversation,
        ),
      ).toEqual([sibling]);
      expect([...publications.at(-1)!.receipt.facts.values()]).toEqual([{ kind: "absent" }]);
    } finally {
      unsubscribe();
    }
  });
});

it("retires failed binding fact installation without hiding the durable commit", async () => {
  await withOpenClawTestState({ label: "binding-failed-receipt" }, async () => {
    const record = binding("receipt-failure");
    const publications: CurrentConversationBindingPublication[] = [];
    const unsubscribeFacts = currentConversationBindingPublication.subscribeFacts((change) => {
      if (!("receipt" in change)) {
        return;
      }
      const { receipt } = change;
      if ([...receipt.facts.values()].some((fact) => fact.kind === "postimage")) {
        throw new Error("synthetic binding projection failure");
      }
    });
    const unsubscribe = currentConversationBindingPublication.subscribe((publication) =>
      publications.push(publication),
    );
    try {
      expect(writeBinding(record)).toEqual(record);
      expect(resolveCurrentConversationBindingRecord(record.conversation)).toEqual(record);
      expect(publications).toHaveLength(1);
      expect([...publications[0]!.receipt.facts.values()]).toEqual([{ kind: "unknown" }]);
    } finally {
      unsubscribeFacts();
      unsubscribe();
    }
  });
});

it("publishes SQLite's actual binding and reverse-index keys for non-scalar text", async () => {
  await withOpenClawTestState({ label: "binding-native-text-receipt" }, async () => {
    const record = binding("receipt-\ud800");
    record.targetSessionKey = "agent:main:receipt-\ud800";
    const publications: CurrentConversationBindingPublication[] = [];
    const unsubscribe = currentConversationBindingPublication.subscribe((publication) =>
      publications.push(publication),
    );
    try {
      writeBinding(record);
      expect(publications).toHaveLength(1);
      expect([...publications[0]!.receipt.facts.keys()]).toEqual([
        "demo\u241fdefault\u241f\u241freceipt-\ufffd",
      ]);
      expect(publications[0]!.sessionKeys).toEqual(["agent:main:receipt-\ufffd"]);
      const { db } = openOpenClawStateDatabase();
      expect(
        db
          .prepare("SELECT binding_key, target_session_key FROM current_conversation_bindings")
          .get(),
      ).toEqual({
        binding_key: "demo\u241fdefault\u241f\u241freceipt-\ufffd",
        target_session_key: "agent:main:receipt-\ufffd",
      });
    } finally {
      unsubscribe();
    }
  });
});
