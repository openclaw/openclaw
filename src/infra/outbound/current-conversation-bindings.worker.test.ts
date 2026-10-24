import fs from "node:fs/promises";
import { aroundEach, assert, expect, it, onTestFinished, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import * as workerStore from "../../state/openclaw-state-worker-store.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel-constants.js";
import { requireNodeSqlite } from "../node-sqlite.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../sqlite-worker-contract.js";
import * as admission from "../sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../sqlite-worker-owner-probe.test-support.js";
import {
  createAccountScopedConversationBindingManager as createManager,
  createAccountScopedConversationBindingManagerV2 as createManagerV2,
} from "./account-scoped-conversation-bindings.js";
import { resolveBoundDeliveryDestination } from "./bound-delivery-router.js";
import {
  bindCurrentConversationRecordAsync as bindRecord,
  listCurrentConversationBindingRecordsBySessionsAsync as listRecords,
  removeCurrentConversationBindingsAsync as removeRecords,
  inspectCurrentConversationBindingRecordAsync as inspectRecord,
  readCurrentConversationBindingSelectionAsync as readSelection,
  readGenericCurrentConversationBindingSelectionAsync as readGenericSelection,
  resolveCurrentConversationBindingRecordAsync as resolveRecord,
  touchCurrentConversationBindingRecordAsync as touchRecord,
  updateCurrentConversationBindingRecord as updateRecord,
} from "./current-conversation-bindings.js";
import { updateCurrentConversationBindingRecordInDatabase as updateRecordInDatabase } from "./current-conversation-bindings.kernel.js";
import { currentConversationBindingPublication as publication } from "./current-conversation-bindings.publication.js";
import {
  recordPublications,
  type CurrentConversationBindingPublication,
} from "./current-conversation-bindings.test-support.js";
import { conversationBindingOperations } from "./current-conversation-bindings.worker.js";
import { expectedCurrentSessionBinding } from "./session-binding-native-selection.js";
import {
  getSessionBindingService,
  prepareSessionBindingInspections,
  listSessionBindingsBySessionsAsync,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
} from "./session-binding-service.js";
import type { SessionBindingRecord } from "./session-binding.types.js";

const service = getSessionBindingService();

aroundEach(async (runTest) => {
  try {
    await withOpenClawTestState({ label: "current-bindings" }, runTest);
  } finally {
    vi.restoreAllMocks();
  }
});

function record(
  conversationId: string,
  accountId = "default",
  overrides: Partial<SessionBindingRecord> = {},
): SessionBindingRecord {
  return {
    bindingId: `${accountId}:${conversationId}`,
    targetSessionKey: "agent:main:current",
    targetKind: "session",
    conversation: { channel: "fixture", accountId, conversationId },
    status: "active",
    boundAt: Date.now(),
    metadata: { opaque: { data: [1, "persisted"] }, lastActivityAt: 1 },
    ...overrides,
  };
}

function managerOptions(
  overrides: Partial<Parameters<typeof createManager<SessionBindingRecord["targetKind"]>>[0]> = {},
) {
  return {
    channel: "fixture",
    accountId: "owner",
    cfg: {},
    stateKey: Symbol("binding-worker"),
    toStoredTargetKind: (kind: SessionBindingRecord["targetKind"]) => kind,
    toSessionBindingTargetKind: (kind: SessionBindingRecord["targetKind"]) => kind,
    ...overrides,
  };
}

function internalConversation(conversationId: string) {
  return { channel: INTERNAL_MESSAGE_CHANNEL, accountId: "default", conversationId };
}

function bindSession(
  conversation: SessionBindingRecord["conversation"],
  targetSessionKey: string,
  metadata?: SessionBindingRecord["metadata"],
) {
  return service.bind({
    conversation,
    targetSessionKey,
    targetKind: "session",
    ...(metadata ? { metadata } : {}),
  });
}

async function prepare(conversation: SessionBindingRecord["conversation"]) {
  const prepared = await prepareSessionBindingInspections([conversation]);
  onTestFinished(() => prepared.dispose());
  return prepared;
}

function bindingRows(columns = "*") {
  return openOpenClawStateDatabase().db.prepare(
    `SELECT ${columns} FROM current_conversation_bindings WHERE binding_id = ?`,
  );
}

function touch(binding: SessionBindingRecord, at: number) {
  return touchRecord({ conversation: binding.conversation, bindingId: binding.bindingId, at });
}

function facts(value: CurrentConversationBindingPublication) {
  return [...value.receipt.facts.values()];
}

type BindingChange = Parameters<Parameters<typeof publication.subscribeFacts>[0]>[0];
function recordEvents(select: (change: BindingChange) => string | undefined) {
  const events: string[] = [];
  onTestFinished(
    publication.subscribeFacts((change) => {
      const event = select(change);
      if (event !== undefined) {
        events.push(event);
      }
    }),
  );
  return events;
}

function seed(...records: SessionBindingRecord[]) {
  for (const value of records) {
    updateRecord(value.conversation, () => value);
  }
}

function allRows() {
  return openOpenClawStateDatabase()
    .db.prepare("SELECT * FROM current_conversation_bindings ORDER BY binding_key")
    .all();
}

it.each([
  ["missing", undefined],
  ["unsupported", { supportsCurrentConversationBinding: false }],
  [
    "disabled",
    {
      supportsCurrentConversationBinding: true,
      isCurrentConversationBindingSupported: () => false,
    },
  ],
] as const)("fences %s support during selection", async (_mode, unavailable) => {
  const previousRegistry = captureActivePluginRegistrySnapshot();
  onTestFinished(() => restoreActivePluginRegistrySnapshot(previousRegistry));
  const conversation = record("higher-priority-child").conversation;
  const registry = (conversationBindings?: unknown) =>
    createTestRegistry(
      conversationBindings
        ? [
            {
              pluginId: conversation.channel,
              source: "test",
              plugin: { id: conversation.channel, conversationBindings },
            },
          ]
        : [],
    );
  const supported = { supportsCurrentConversationBinding: true };
  setActivePluginRegistry(registry(supported));
  const bound = await bindSession(conversation, "agent:main:child");
  expect(await readGenericSelection([conversation])).toEqual([bound]);
  setActivePluginRegistry(registry(unavailable));
  expect(await readGenericSelection([conversation])).toEqual([null]);
  const pending = readGenericSelection([conversation]);
  setActivePluginRegistry(registry(supported));
  await expect(pending).rejects.toThrow(
    "Generic conversation binding owner is no longer available",
  );
  expect(await service.resolveByConversationAsync(conversation)).toEqual(bound);
});

it("reads an ordered, captured selection without creating or repairing stored bindings", async () => {
  const child = record("child");
  const base = record("base");
  const expired = record("expired", "default", { expiresAt: 1 });
  const requestedBase = { ...base.conversation };
  const refs = [child.conversation, expired.conversation, requestedBase];
  expect(await readSelection(refs)).toEqual([null, null, null]);
  await expect(fs.stat(resolveOpenClawStateSqlitePath())).rejects.toMatchObject({
    code: "ENOENT",
  });
  seed(base, expired);
  const before = allRows();
  const pending = readSelection(refs);
  requestedBase.conversationId = "different";
  refs.reverse();
  expect(await pending).toEqual([null, null, base]);
  expect(allRows()).toEqual(before);
});

it("selects live binding facts even inside an older retained discovery snapshot", async () => {
  const child = record("child");
  const base = record("base");
  seed(base);
  await withOpenClawStateDatabaseReadSnapshot(async () => {
    seed(child);
    expect(await inspectRecord(child.conversation)).toBeNull();
    expect(await readSelection([child.conversation, base.conversation])).toEqual([child, base]);
  });
});

it("keeps inspection noncreating and performs durable read, expiry, and scoped touch without host data SQL", async () => {
  const current = record("conversation");
  expect(await inspectRecord(current.conversation)).toBeNull();
  await expect(fs.stat(resolveOpenClawStateSqlitePath())).rejects.toMatchObject({
    code: "ENOENT",
  });

  const expired = record("expired", "default", { expiresAt: 1 });
  const sibling = record("conversation", "sibling");
  seed(current, expired, sibling);
  const row = bindingRows();
  const before = row.get(expired.bindingId);
  expect(await inspectRecord(expired.conversation)).toBeNull();
  expect(row.get(expired.bindingId)).toEqual(before);
  const callerConversation = { ...current.conversation, callerContext: () => "host only" };
  const hostSql = observeHostDataSql();
  try {
    expect(await inspectRecord(callerConversation)).toEqual(current);
    expect(await resolveRecord(callerConversation)).toEqual(current);
    const at = current.boundAt + 1_000;
    const policy = {
      idleTimeoutMs: 60_000,
      maxAgeMs: 60_500,
      targetKinds: {
        subagent: "subagent" as const,
        session: "session" as const,
        callerContext: () => "host only",
      },
      callerContext: () => "host only",
    };
    const touched = await touchRecord({
      conversation: callerConversation,
      bindingId: current.bindingId,
      at,
      accountPolicy: policy,
    });
    expect(touched).toMatchObject({
      expiresAt: current.boundAt + 60_500,
      metadata: { opaque: current.metadata!.opaque, lastActivityAt: at },
    });
    expect(await resolveRecord(expired.conversation)).toBeNull();
    expect(hostSql.queries).toEqual([]);
  } finally {
    hostSql.restore();
  }
  expect(row.get(expired.bindingId)).toBeUndefined();
  // A mismatched binding id cannot mutate a replacement target's metadata.
  await touchRecord({
    conversation: sibling.conversation,
    bindingId: current.bindingId,
    at: 99,
  });
  expect(await inspectRecord(sibling.conversation)).toEqual(sibling);
});

it("reuses resolved bindings until sync or worker writes publish new facts", async () => {
  const original = record("cached");
  openOpenClawStateDatabase();
  const run = vi.spyOn(workerStore, "runOpenClawStateWorkerOperation");
  const cached = async (expected: SessionBindingRecord | null) => {
    run.mockClear();
    const resolved = await resolveRecord(original.conversation);
    expect(resolved).toEqual(expected);
    expect(run).not.toHaveBeenCalled();
    return resolved;
  };
  expect(await resolveRecord(original.conversation)).toBeNull();
  await cached(null);
  seed(original);
  const resolved = await cached(original);
  resolved!.metadata!.lastActivityAt = 99;
  await cached(original);
  const replacement = { ...original, targetSessionKey: "agent:main:replacement" };
  await bindRecord({ record: replacement });
  await cached(replacement);
  await touch(original, 100);
  const touched = { ...replacement, metadata: { ...replacement.metadata, lastActivityAt: 100 } };
  await cached(touched);
  seed(record("sibling"));
  await cached(touched);
  await removeRecords({ conversation: original.conversation, bindingId: original.bindingId });
  await cached(null);
});
it("keeps a prepared selection current after a completed no-op worker resolve", async () => {
  openOpenClawStateDatabase();
  const conversation = internalConversation("missing-prepared");
  const prepared = await prepare(conversation);
  const changes = recordEvents((change) =>
    "receipt" in change
      ? "receipt"
      : change.kind === "settled"
        ? (change.outcome ?? "unknown")
        : change.kind,
  );
  expect(prepared.inspect()).toMatchObject([{ status: "available", binding: null }]);
  expect(await resolveRecord(conversation)).toBeNull();
  expect(changes).toEqual(["pending", "unchanged"]);
  expect(prepared.inspect()).toMatchObject([{ status: "available", binding: null }]);
});

it("invalidates prepared effect ownership after committed binding replacement and deletion", async () => {
  const conversation = internalConversation("prepared");
  const original = await bindSession(conversation, "agent:main:original");
  const prepared = await prepare(conversation);
  const sql = observeHostDataSql();
  onTestFinished(() => sql.restore());
  expect(prepared.inspect()).toMatchObject([{ binding: original }]);
  sql.restore();
  expect(sql.queries).toEqual([]);
  const replacement = { ...original, targetSessionKey: "agent:main:replacement" };
  await bindRecord({ record: replacement });
  expect(() => prepared.inspect()).toThrow("ownership changed");
  const current = await prepare(conversation);
  expect(current.inspect()).toMatchObject([{ binding: replacement }]);
  await removeRecords({ conversation });
  expect(() => current.inspect()).toThrow("ownership changed");
  prepared.dispose();
  expect(() => prepared.inspect()).toThrow("no longer active");
});

it.each([
  { operation: "touch", stage: "transaction" },
  { operation: "touch", stage: "commit" },
  { operation: "bind", stage: "transaction" },
  { operation: "bind", stage: "commit" },
] as const)("rolls back $operation at revoked $stage", async ({ operation, stage }) => {
  const conversation = internalConversation("guarded");
  const original = await bindSession(conversation, "agent:main:original");
  const row = bindingRows();
  const before = row.get(original.bindingId);
  let active = true;
  probe.admission(admission, (request, grant, admit) => {
    if (request.stage === stage) {
      active = false;
    }
    admit(request, grant);
  });
  const message = operation === "touch" ? "Binding owner retired" : "Binding caller retired";
  const assertCurrent = () => {
    if (!active) {
      throw new Error(message);
    }
  };
  await expect(
    operation === "touch"
      ? touchRecord({ conversation, bindingId: original.bindingId, at: 99 }, assertCurrent)
      : service.bind({
          conversation,
          targetSessionKey: "agent:main:replacement",
          targetKind: "session",
          assertCurrent,
        }),
  ).rejects.toThrow(message);
  expect(row.get(original.bindingId)).toEqual(before);
  expect(await service.resolveByConversationAsync(conversation)).toEqual(original);
});
it("keeps account touch bytes identical and rejects a manager shadowed by another adapter", async () => {
  const manager = createManager({
    ...managerOptions(),
    cfg: { session: { threadBindings: { idleHours: 1, maxAgeHours: 2 } } },
    toStoredTargetKind: (kind) => (kind === "subagent" ? "child" : "ordinary"),
    toSessionBindingTargetKind: (kind) => (kind === "child" ? "subagent" : "session"),
  });
  const ref = { channel: "fixture", accountId: "owner", conversationId: "thread" };
  const replacement: SessionBindingAdapter = {
    channel: ref.channel,
    accountId: ref.accountId,
    listBySession: () => [],
    resolveByConversation: () => null,
  };
  try {
    manager.bindConversation({
      conversationId: "thread",
      targetSessionKey: "agent:main:target",
      targetKind: "session",
      metadata: { label: "owned", opaque: { stable: [1, 2] } },
    });
    const original = await inspectRecord(ref);
    assert(original, "Missing fixture account binding");
    const row = bindingRows("record_json, metadata_json, expires_at");
    const at = original.boundAt + 1_000;
    manager.touchConversation("thread", at);
    const expected = row.get(original.bindingId);
    seed(original);
    await service.touchAsync(original.bindingId, at, ref);
    expect(row.get(original.bindingId)).toEqual(expected);

    const pending = service.touchAsync(original.bindingId, at + 1_000, ref);
    registerSessionBindingAdapter(replacement);
    await expect(pending).rejects.toThrow("no longer active");
    expect(row.get(original.bindingId)).toEqual(expected);
  } finally {
    unregisterSessionBindingAdapter({ ...ref, adapter: replacement });
    manager.stop();
  }
});

it("joins expiry pruning refused by the stopped manager without deleting its row", async () => {
  const manager = createManager(managerOptions());
  try {
    const bound = await bindSession(
      record("expired-list", "owner").conversation,
      "agent:main:current",
    );
    seed({ ...bound, expiresAt: 1 });
    const query = bindingRows();
    const before = query.get(bound.bindingId);
    expect(before).toBeDefined();
    probe.admission(admission, (request, grant, admit) => {
      if (request.stage === "transaction") {
        manager.stop();
      }
      admit(request, grant);
    });
    await expect(
      resolveBoundDeliveryDestination({ targetSessionKey: bound.targetSessionKey }),
    ).rejects.toMatchObject({ code: "BINDING_ADAPTER_UNAVAILABLE" });
    expect(query.get(bound.bindingId)).toEqual(before);
  } finally {
    vi.restoreAllMocks();
    manager.stop();
  }
});

it.each(["replaced", "removed", "expired", "malformed"] as const)(
  "refreshes %s foreign bindings before pruning",
  async (change) => {
    const expired = record("expired-batch", "default", {
      targetSessionKey: "agent:main:expired",
      expiresAt: 1,
    });
    const original = record("valid-batch", "default", { targetSessionKey: "agent:main:valid" });
    seed(expired, original);
    const database = openOpenClawStateDatabase();
    const env = { ...process.env };
    const foreign = new (requireNodeSqlite().DatabaseSync)(database.path);
    const replacement =
      change === "expired"
        ? { ...original, expiresAt: 1 }
        : { ...original, metadata: { label: "foreign replacement" } };
    const grant = admission.createSqliteWorkerOperationAdmission((_request, allow) => {
      allow();
    });
    const postMessage = grant.port.postMessage.bind(grant.port);
    // The canonical operation and its private-port owner share this test thread.
    const dispatch = vi
      .spyOn(grant.port, "postMessage")
      .mockImplementation((message, transfers) => {
        postMessage(message, transfers);
        grant.service();
      });
    try {
      const result = admission.withSqliteWorkerOperationAdmission({ port: grant.port }, () =>
        conversationBindingOperations["conversationBindings.listBySessions"](
          {
            targetSessionKeys: [expired.targetSessionKey, original.targetSessionKey],
            scope: original.conversation,
          },
          {
            open: () => database,
            write: (operation, options) =>
              runOpenClawStateWriteTransaction(operation, { database, env }, options),
            writeAdmitted: () => {
              throw new Error("Conversation bindings retain their custom admission");
            },
            stateOptions: () => {
              // This existing context callback runs after prefetch and before BEGIN.
              expect(database.db.isTransaction).toBe(false);
              if (change === "malformed") {
                foreign
                  .prepare(
                    "UPDATE current_conversation_bindings SET record_json = ? WHERE binding_id = ?",
                  )
                  .run("{", original.bindingId);
              } else {
                updateRecordInDatabase(foreign, original.conversation, () =>
                  change === "removed" ? null : replacement,
                );
              }
              return { path: database.path, env };
            },
          },
        ),
      );
      expect(result).toEqual([[], change === "replaced" ? [replacement] : []]);
      const row = bindingRows("record_json");
      expect(row.get(expired.bindingId)).toBeUndefined();
      expect(row.get(original.bindingId)).toEqual(
        change === "replaced"
          ? { record_json: JSON.stringify(replacement) }
          : change === "malformed"
            ? { record_json: "{" }
            : undefined,
      );
    } finally {
      dispatch.mockRestore();
      grant.finish();
      foreign.close();
    }
  },
);

it("batches generic and account-owned bindings without caller-thread SQL", async () => {
  const manager = createManager(managerOptions());
  openOpenClawStateDatabase();
  const hostSql = observeHostDataSql();
  onTestFinished(() => hostSql.restore());
  onTestFinished(() => manager.stop());
  const generic = await bindSession(internalConversation("batch"), "agent:main:generic");
  const account = await bindSession(record("batch", "owner").conversation, "agent:main:account");
  const listing = await listSessionBindingsBySessionsAsync([
    generic.targetSessionKey,
    account.targetSessionKey,
    "agent:main:absent",
  ]);
  expect([...listing.values()]).toEqual([[generic], [account], []]);
  const { bindingId, conversation } = account;
  const { targetSessionKey, conversation: scope } = generic;
  expect(await service.unbind({ bindingId, scope: conversation, reason: "test" })).toEqual([
    account,
  ]);
  expect(await service.unbind({ targetSessionKey, scope, reason: "test" })).toEqual([generic]);
  expect(await service.resolveByConversationAsync(account.conversation)).toBeNull();
  expect(await service.resolveByConversationAsync(generic.conversation)).toBeNull();
  expect(hostSql.queries).toEqual([]);
});

it.each(["bind", "unbind"] as const)(
  "rejects stale %s without overwriting its replacement",
  async (mutation) => {
    const conversation = internalConversation("replaced");
    const original = await bindSession(conversation, "agent:main:original");
    const replacement = await bindSession(conversation, "agent:main:replacement");
    const stale = { [expectedCurrentSessionBinding]: original };
    const pending =
      mutation === "bind"
        ? service.bind({
            ...stale,
            conversation,
            targetSessionKey: "agent:main:stale",
            targetKind: "session",
          })
        : service.unbind({
            ...stale,
            bindingId: original.bindingId,
            scope: conversation,
            reason: "stale detach",
          });
    await expect(pending).rejects.toThrow("Conversation binding changed");
    expect(await service.resolveByConversationAsync(conversation)).toEqual(replacement);
  },
);

it("delivers committed worker bind, touch and batch-expiry facts before their replies", async () => {
  const original = record("receipt-worker");
  const publications = recordPublications();
  const bound = await bindRecord({ record: original });
  expect(bound).toMatchObject(original);
  expect(publications.map(facts)).toEqual([[{ kind: "postimage", value: bound }]]);
  const touched = await touch(original, 50);
  expect(touched?.metadata?.lastActivityAt).toBe(50);
  expect(facts(publications.at(-1)!)).toEqual([{ kind: "postimage", value: touched }]);
  seed(...["expired-one", "expired-two"].map((id) => record(id, "default", { expiresAt: 1 })));
  publications.length = 0;
  expect(await listRecords([original.targetSessionKey], original.conversation)).toEqual([
    [touched],
  ]);
  expect(publications.map(facts)).toEqual([[{ kind: "absent" }, { kind: "absent" }]]);
  expect(publications[0]!.sessionKeys).toEqual([original.targetSessionKey]);
  expect(await removeRecords({ conversation: original.conversation })).toEqual([touched]);
  expect(facts(publications.at(-1)!)).toEqual([{ kind: "absent" }]);
});

it("cannot restore a newer native deletion when a committed worker receipt arrives late", async () => {
  const original = record("late-receipt");
  seed(original);
  const observe = admission.observeSqliteWorkerCommittedFacts;
  vi.spyOn(admission, "observeSqliteWorkerCommittedFacts").mockImplementation((owner, listener) => {
    observe(owner, (receipt) => {
      updateRecord(original.conversation, () => null);
      listener(receipt);
    });
  });
  const publications = recordPublications();
  await touch(original, 20);
  expect(await inspectRecord(original.conversation)).toBeNull();
  expect(publications.map(facts)).toEqual([[{ kind: "absent" }], [{ kind: "unknown" }]]);
});

it("retires binding coverage after unknown native settlement", async () => {
  const original = record("unknown-settlement");
  const nativeOutcomes: string[] = [];
  const outcomes = recordEvents((change) =>
    "kind" in change && change.kind === "settled" ? (change.outcome ?? "missing") : undefined,
  );
  const createAdmission = admission.createSqliteWorkerOperationAdmission;
  vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation((...args) => {
    const owner = createAdmission(...args);
    const finish = owner.finish.bind(owner);
    owner.finish = () => {
      finish();
      const settled = owner.settlement;
      if (settled?.committed && settled.kind === "completed") {
        nativeOutcomes.push(settled.kind);
        // Preserve the real commit receipt while simulating an uncertain terminal observation.
        vi.spyOn(owner, "settlement", "get").mockReturnValue({ ...settled, kind: "unknown" });
      }
    };
    return owner;
  });
  await bindRecord({ record: original });
  expect(await inspectRecord(original.conversation)).toEqual(original);
  expect(nativeOutcomes).toEqual(["completed"]);
  expect(outcomes.at(-1)).toBe("unknown");
});

it("commits oversized expiry batches and retires binding coverage before replying", async () => {
  // Short record IDs keep only the real conversation keys responsible for receipt overflow.
  const suffix = "x".repeat(SQLITE_WORKER_MAX_MESSAGE_BYTES / 16);
  for (let index = 0; index < 17; index++) {
    seed(record(`${index}:${suffix}`, "default", { bindingId: `expired-${index}`, expiresAt: 1 }));
  }
  const { db } = openOpenClawStateDatabase();
  const count = () =>
    db.prepare("SELECT count(*) AS count FROM current_conversation_bindings").get();
  expect(count()).toEqual({ count: 17 });
  const events = recordEvents((change) => ("kind" in change ? change.kind : undefined));
  await expect(
    listRecords(["agent:main:current"], {
      channel: "fixture",
      accountId: "default",
    }),
  ).resolves.toEqual([[]]);
  events.push("reply");
  expect(count()).toEqual({ count: 0 });
  expect(events).toEqual(["pending", "unknown", "settled", "reply"]);
});

it("runs the V2 account manager's complete persistence lifecycle in workers", async () => {
  const manager = createManagerV2(
    managerOptions({
      cfg: { session: { threadBindings: { idleHours: 0, maxAgeHours: 0 } } },
    }),
  );
  expect(manager).not.toHaveProperty("bindConversation");
  openOpenClawStateDatabase();
  const hostSql = observeHostDataSql();
  onTestFinished(() => hostSql.restore());
  onTestFinished(() => manager.stop());
  const input = {
    conversationId: "room",
    targetSessionKey: "agent:main:managed",
    targetKind: "session" as const,
  };
  const binding = await manager.bindConversationAsync({
    ...input,
    metadata: { label: "worker-owned", cleared: "old", opaque: { retained: true } },
  });
  expect(binding).toMatchObject({ conversationId: "room", label: "worker-owned" });
  expect(await manager.getByConversationIdAsync("room")).toEqual(binding);
  expect(await manager.listBySessionKeyAsync("agent:main:managed")).toEqual([binding]);
  await manager.bindConversationAsync({
    ...input,
    metadata: { label: "refreshed", cleared: undefined },
  });
  const refreshed = await inspectRecord(record("room", "owner").conversation);
  expect(refreshed?.metadata).toMatchObject({ label: "refreshed", opaque: { retained: true } });
  expect(refreshed?.metadata?.cleared).toBeUndefined();
  expect(await manager.touchConversationAsync("room", 123)).toMatchObject({
    lastActivityAt: 123,
  });
  expect(await manager.unbindConversationAsync("room")).toMatchObject({ lastActivityAt: 123 });
  expect(await manager.getByConversationIdAsync("room")).toBeUndefined();
  await manager.bindConversationAsync(input);
  expect(await manager.unbindBySessionKeyAsync("agent:main:managed")).toHaveLength(1);
  expect(await manager.listBySessionKeyAsync("agent:main:managed")).toEqual([]);
  expect(hostSql.queries).toEqual([]);
  manager.stop();
  await expect(
    manager.bindConversationAsync({ ...input, conversationId: "closed" }),
  ).rejects.toThrow("no longer active");
});
