import { aroundEach, expect, it, onTestFinished, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  bindCurrentConversationRecordAsync as bindRecord,
  deleteCurrentConversationBindingRecordsBySession as deleteBySession,
  inspectCurrentConversationBindingRecords as inspectRecords,
  listCurrentConversationBindingRecordsBySession as listBySession,
  resolveCurrentConversationBindingRecord as resolveRecord,
  removeCurrentConversationBindingsAsync as removeRecords,
  updateCurrentConversationBindingRecord as updateRecord,
} from "./current-conversation-bindings.js";
import {
  readCurrentConversationBindingListsInDatabase as readLists,
  readCurrentConversationBindingSelectionInDatabase as readSelection,
} from "./current-conversation-bindings.kernel.js";
import { currentConversationBindingPublication as publication } from "./current-conversation-bindings.publication.js";
import type { SessionBindingRecord } from "./session-binding.types.js";

type CurrentConversationBindingPublication = Extract<
  Parameters<Parameters<typeof publication.subscribeFacts>[0]>[0],
  { receipt: unknown }
>;

aroundEach(async (runTest) => {
  try {
    await withOpenClawTestState({ label: "current-bindings" }, runTest);
  } finally {
    vi.restoreAllMocks();
  }
});

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
  return updateRecord(record.conversation, () => record).current;
}

function readColumns(bindingId: string) {
  return openOpenClawStateDatabase()
    .db.prepare("SELECT * FROM current_conversation_bindings WHERE binding_id = ?")
    .get(bindingId);
}

function recordPublications() {
  const publications: CurrentConversationBindingPublication[] = [];
  const unsubscribe = publication.subscribeFacts((value) => {
    if ("receipt" in value) {
      publications.push(value);
    }
  });
  onTestFinished(unsubscribe);
  return publications;
}

function publicationFacts(value: CurrentConversationBindingPublication) {
  return [...value.receipt.facts.values()];
}

function countQueries(classify: (query: string) => "statement" | "freshness" | "selection" | null) {
  const { db } = openOpenClawStateDatabase();
  const execution = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(db),
    ["statement", "freshness", "selection"],
    classify,
  );
  onTestFinished(execution.restore);
  return execution.counts;
}

function freshnessQuery(query: string) {
  return /^PRAGMA data_version$|FROM main\.pragma_data_version\(\)\s*$/iu.test(query);
}

it("reads ordered binding selections and target batches in one statement after committed writes", async () => {
  const original = binding("current");
  const missing = binding("missing");
  writeBinding(original);
  const { db } = openOpenClawStateDatabase();
  const counts = countQueries(() => "statement");
  const refs = [missing.conversation, original.conversation, original.conversation];
  expect(readSelection(db, refs)).toEqual([null, original, original]);
  expect(counts.statement).toBe(1);
  const replacement = { ...original, targetSessionKey: "agent:other:replacement" };
  writeBinding(replacement);
  const before = counts.statement;
  expect(readSelection(db, refs)).toEqual([null, replacement, replacement]);
  expect(counts.statement - before).toBe(1);
  writeBinding(missing);
  const listBefore = counts.statement;
  const targets = [
    replacement.targetSessionKey,
    missing.targetSessionKey,
    replacement.targetSessionKey,
  ];
  expect(
    readLists(db, targets, {
      channel: "demo",
      accountId: "default",
    }).map((list) => list.records),
  ).toEqual([[replacement], [missing], [replacement]]);
  expect(counts.statement - listBefore).toBe(1);
  expect(readLists(db, targets)).toEqual(
    targets.map(() => ({ records: [], requiresPrune: false })),
  );
});

it("invalidates warm main-thread binding rows after worker receipts and database reopen", async () => {
  const original = binding("worker-written");
  writeBinding(original);
  const inspect = () => inspectRecords([original.conversation])[0];
  expect([inspect(), inspect()]).toEqual([original, original]);
  const owned = openOpenClawStateDatabase();
  const counts = countQueries((query) => (freshnessQuery(query) ? "freshness" : null));
  const replacement = {
    ...original,
    targetSessionKey: "agent:other:replacement",
    metadata: { opaque: { fresh: [1, 2] } },
  };
  expect(await bindRecord({ record: replacement })).toEqual(replacement);
  expect(inspect()).toEqual(replacement);
  expect(counts.freshness).toBe(0);
  await closeOpenClawStateDatabaseAsync();
  expect(openOpenClawStateDatabase().db === owned.db).toBe(false);
  expect(inspect()).toEqual(replacement);
  expect(await removeRecords({ conversation: original.conversation })).toEqual([replacement]);
  expect(inspect()).toBeNull();
});

it("reuses unchanged binding rows while local updates, expiry, and returned objects stay current", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  const original = {
    ...binding("retained"),
    expiresAt: 150,
    metadata: { label: "original" },
  };
  const added = binding("missing");
  writeBinding(original);
  const counts = countQueries((query) =>
    freshnessQuery(query)
      ? "freshness"
      : query.startsWith("with ") && query.includes('"current_conversation_bindings"')
        ? "selection"
        : null,
  );
  const refs = [original.conversation, added.conversation];
  const inspect = () => inspectRecords(refs);
  const selected = inspect();
  expect(selected).toEqual([original, null]);
  selected[0]!.targetSessionKey = "agent:other:consumer";
  selected[0]!.metadata!.label = "consumer";
  expect(inspect()).toEqual([original, null]);
  expect(counts.selection).toBe(1);
  expect(counts.freshness).toBe(0);

  const replacement = { ...original, targetSessionKey: "agent:other:replacement" };
  writeBinding(replacement);
  expect(inspect()).toEqual([replacement, null]);
  writeBinding(added);
  expect(inspect()).toEqual([replacement, added]);
  const readsBeforeExpiry = counts.selection;
  clock.mockReturnValue(150);
  expect(inspect()).toEqual([null, added]);
  expect(counts.selection).toBe(readsBeforeExpiry);
  expect(inspectRecords(refs.toReversed())).toEqual([added, null]);

  deleteBySession(added.targetSessionKey, undefined, false);
  expect(inspect()).toEqual([null, null]);
});

it("round-trips fresh bindings and preserves every scoped and generic list shape", async () => {
  vi.spyOn(Date, "now").mockReturnValue(100);
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
  expect(listBySession(a.targetSessionKey)).toEqual([a, c]);
  expect(listBySession(a.targetSessionKey, scoped)).toEqual([b, a]);

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
  expect(listBySession(b.targetSessionKey, scoped)).toEqual([a]);
  expect(listBySession(changed.targetSessionKey, scoped)).toEqual([changed]);
  expect(resolveRecord(b.conversation)).toEqual(changed);
  writeBinding(b);
  expect(resolveRecord(b.conversation)).toEqual(b);

  expect(deleteBySession(a.targetSessionKey, scoped, true)).toEqual([a]);
  expect(resolveRecord(b.conversation)).toEqual(b);
  expect(resolveRecord(c.conversation)).toEqual(c);
  expect(deleteBySession(a.targetSessionKey, undefined, false)).toEqual([b, c]);
  expect(resolveRecord(unrelated.conversation)).toEqual(unrelated);
});

it("preserves the committed row when a metadata update cannot be serialized", async () => {
  const original = binding("cyclic-metadata");
  writeBinding(original);
  const readRow = () => readColumns(original.bindingId);
  const before = readRow();
  expect(before).toBeDefined();
  const metadata: Record<string, unknown> = {};
  metadata.self = metadata;
  expect(() =>
    updateRecord(original.conversation, () => ({
      ...original,
      targetSessionKey: "agent:other:rejected",
      metadata,
    })),
  ).toThrow(TypeError);
  expect(readRow()).toEqual(before);
  expect(resolveRecord(original.conversation)).toEqual(original);
});

it("installs native binding facts after commit and discards nested rollback", async () => {
  const first = binding("receipt-one", "default", true);
  const second = binding("receipt-two", "default", true);
  const discarded = binding("receipt-rollback", "default", true);
  const facts = new Map<string, string>();
  const publications: CurrentConversationBindingPublication[] = [];
  const unsubscribeFacts = publication.subscribeFacts((change) => {
    if (!("receipt" in change)) {
      return;
    }
    publications.push(change);
    const { receipt } = change;
    for (const [key, fact] of receipt.facts) {
      if (fact.kind === "postimage") {
        facts.set(key, fact.value.targetSessionKey);
      } else {
        facts.delete(key);
      }
    }
  });
  onTestFinished(() => unsubscribeFacts());
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
  expect([...facts.values()]).toEqual([first.targetSessionKey, second.targetSessionKey]);
  expect(publications.every(({ receipt }) => typeof receipt.source.identity === "string")).toBe(
    true,
  );
  expect(resolveRecord(discarded.conversation)).toBeNull();
  expect(() =>
    runOpenClawStateWriteTransaction(() => {
      writeBinding(discarded);
      throw new Error("rollback outer binding");
    }),
  ).toThrow("rollback outer binding");
  expect(publications).toHaveLength(2);
});

it("publishes rebind, legacy repair, expiry and scoped deletion reverse-index invalidations", async () => {
  const original = binding("receipt-rebind", "default", true);
  const sibling = binding("receipt-sibling", "other", true);
  writeBinding(original);
  writeBinding(sibling);
  const publications = recordPublications();
  const rebound = { ...original, targetSessionKey: "agent:main:replacement" };
  writeBinding(rebound);
  expect(publications.at(-1)?.sessionKeys).toEqual([
    original.targetSessionKey,
    rebound.targetSessionKey,
  ]);
  const { db } = openOpenClawStateDatabase();
  db.prepare("UPDATE current_conversation_bindings SET binding_key = ? WHERE binding_id = ?").run(
    "old-receipt-key",
    original.bindingId,
  );
  expect(resolveRecord(original.conversation)).toEqual(rebound);
  const repaired = publications.at(-1)!;
  expect(repaired.receipt.facts.get("old-receipt-key")).toEqual({ kind: "absent" });
  expect(publicationFacts(repaired)).toContainEqual({
    kind: "postimage",
    value: rebound,
  });
  writeBinding({ ...rebound, expiresAt: 1 });
  expect(listBySession(rebound.targetSessionKey)).toEqual([]);
  expect(publicationFacts(publications.at(-1)!)).toEqual([{ kind: "absent" }]);
  expect(publications.at(-1)?.sessionKeys).toEqual([rebound.targetSessionKey]);
  expect(deleteBySession(sibling.targetSessionKey, original.conversation)).toEqual([]);
  expect(resolveRecord(sibling.conversation)).toEqual(sibling);
  expect(deleteBySession(sibling.targetSessionKey, sibling.conversation)).toEqual([sibling]);
  expect(publicationFacts(publications.at(-1)!)).toEqual([{ kind: "absent" }]);
});

it("retires failed binding fact installation without hiding the durable commit", async () => {
  const record = binding("receipt-failure");
  let retiredFacts: ReturnType<typeof publicationFacts> = [];
  const unsubscribeFacts = publication.subscribeFacts((change) => {
    if (!("receipt" in change)) {
      return;
    }
    const facts = publicationFacts(change);
    if (facts.some((fact) => fact.kind === "postimage")) {
      throw new Error("synthetic binding projection failure");
    }
    retiredFacts = facts;
  });
  onTestFinished(unsubscribeFacts);
  expect(writeBinding(record)).toEqual(record);
  expect(retiredFacts).toEqual([{ kind: "unknown" }]);
  expect(resolveRecord(record.conversation)).toEqual(record);
});

it("publishes SQLite's actual binding and reverse-index keys for non-scalar text", async () => {
  const record = binding("receipt-\ud800");
  record.targetSessionKey = "agent:main:receipt-\ud800";
  const publications = recordPublications();
  writeBinding(record);
  expect(publications).toHaveLength(1);
  expect([...publications[0]!.receipt.facts.keys()]).toEqual([
    "demo\u241fdefault\u241f\u241freceipt-\ufffd",
  ]);
  expect(publications[0]!.sessionKeys).toEqual(["agent:main:receipt-\ufffd"]);
  const { db } = openOpenClawStateDatabase();
  expect(
    db.prepare("SELECT binding_key, target_session_key FROM current_conversation_bindings").get(),
  ).toEqual({
    binding_key: "demo\u241fdefault\u241f\u241freceipt-\ufffd",
    target_session_key: "agent:main:receipt-\ufffd",
  });
});
