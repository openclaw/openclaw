import fs from "node:fs/promises";
import { aroundEach, expect, it, onTestFinished, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
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
  bindGenericCurrentConversation as bindGeneric,
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

function record(conversationId: string, accountId = "default"): SessionBindingRecord {
  return {
    bindingId: `${accountId}:${conversationId}`,
    targetSessionKey: "agent:main:current",
    targetKind: "session",
    conversation: { channel: "fixture", accountId, conversationId },
    status: "active",
    boundAt: Date.now(),
    metadata: { opaque: { data: [1, "persisted"] }, lastActivityAt: 1 },
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
  return getSessionBindingService().bind({
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

it.each(["missing", "unsupported", "disabled"] as const)(
  "fences %s generic support when the registry changes during an ordered selection",
  async (mode) => {
    const previousRegistry = captureActivePluginRegistrySnapshot();
    try {
      const conversation = {
        channel: "selection-fixture",
        accountId: "default",
        conversationId: "higher-priority-child",
      };
      const registry = (supported: boolean, eligibility?: () => boolean) =>
        createTestRegistry([
          {
            pluginId: conversation.channel,
            source: "test",
            plugin: {
              id: conversation.channel,
              meta: { aliases: [] },
              conversationBindings: {
                supportsCurrentConversationBinding: supported,
                ...(eligibility ? { isCurrentConversationBindingSupported: eligibility } : {}),
              },
            },
          },
        ]);
      const service = getSessionBindingService();
      setActivePluginRegistry(registry(true));
      const bound = await bindSession(conversation, "agent:main:child");
      expect(await readGenericSelection([conversation])).toEqual([bound]);
      let eligibilityCalls = 0;
      setActivePluginRegistry(
        mode === "missing"
          ? createTestRegistry([])
          : mode === "unsupported"
            ? registry(false)
            : registry(true, () => {
                eligibilityCalls += 1;
                return false;
              }),
      );
      expect(await readGenericSelection([conversation])).toEqual([null]);
      eligibilityCalls = 0;
      const pending = readGenericSelection([conversation]);
      setActivePluginRegistry(registry(true));
      await expect(pending).rejects.toThrow(
        "Generic conversation binding owner is no longer available",
      );
      expect(eligibilityCalls).toBe(mode === "disabled" ? 1 : 0);
      expect(await service.resolveByConversationAsync(conversation)).toEqual(bound);
    } finally {
      restoreActivePluginRegistrySnapshot(previousRegistry);
    }
  },
);

it("reads an ordered, captured selection without creating or repairing stored bindings", async () => {
  const child = record("child");
  const base = record("base");
  const expired = { ...record("expired"), expiresAt: 1 };
  const requestedBase = { ...base.conversation };
  const refs = [child.conversation, expired.conversation, requestedBase];
  expect(await readSelection(refs)).toEqual([null, null, null]);
  await expect(fs.stat(resolveOpenClawStateSqlitePath())).rejects.toMatchObject({
    code: "ENOENT",
  });
  for (const value of [base, expired]) {
    updateRecord(value.conversation, () => value);
  }
  const { db } = openOpenClawStateDatabase();
  const before = db
    .prepare("SELECT * FROM current_conversation_bindings ORDER BY binding_key")
    .all();
  const pending = readSelection(refs);
  requestedBase.conversationId = "different";
  refs.reverse();
  expect(await pending).toEqual([null, null, base]);
  expect(
    db.prepare("SELECT * FROM current_conversation_bindings ORDER BY binding_key").all(),
  ).toEqual(before);
});

it("selects live binding facts even inside an older retained discovery snapshot", async () => {
  const child = record("child");
  const base = record("base");
  updateRecord(base.conversation, () => base);
  await withOpenClawStateDatabaseReadSnapshot(async () => {
    updateRecord(child.conversation, () => child);
    expect(await inspectRecord(child.conversation)).toBeNull();
    expect(await readSelection([child.conversation, base.conversation])).toEqual([child, base]);
  });
});

it("refuses pending selection publication when its database lifecycle retires", async () => {
  const current = record("retired");
  updateRecord(current.conversation, () => current);
  const pending = readSelection([current.conversation]);
  const refused = expect(pending).rejects.toThrow();
  await closeOpenClawStateDatabaseAsync();
  await refused;
});

it("keeps inspection noncreating and performs durable read, expiry, and scoped touch without host data SQL", async () => {
  let current = record("conversation");
  expect(await inspectRecord(current.conversation)).toBeNull();
  await expect(fs.stat(resolveOpenClawStateSqlitePath())).rejects.toMatchObject({
    code: "ENOENT",
  });

  const expired = { ...record("expired"), expiresAt: 1 };
  const sibling = record("conversation", "sibling");
  for (const value of [current, expired, sibling]) {
    updateRecord(value.conversation, () => value);
  }
  const { db } = openOpenClawStateDatabase();
  const row = db.prepare("SELECT * FROM current_conversation_bindings WHERE binding_id = ?");
  const before = row.get(expired.bindingId);
  expect(await inspectRecord(expired.conversation)).toBeNull();
  expect(row.get(expired.bindingId)).toEqual(before);
  const callerConversation = { ...current.conversation, callerContext: () => "host only" };
  expect(await inspectRecord(callerConversation)).toEqual(current);
  expect(await resolveRecord(callerConversation)).toEqual(current);
  current = {
    ...current,
    targetSessionKey: "agent:main:replacement",
    metadata: { opaque: { changed: true } },
  };
  updateRecord(current.conversation, () => current);
  const hostSql = observeHostDataSql();
  try {
    expect(await inspectRecord(expired.conversation)).toBeNull();
    expect(await resolveRecord(current.conversation)).toEqual(current);
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
    expect(await inspectRecord(sibling.conversation)).toEqual(sibling);
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
  updateRecord(original.conversation, () => original);
  const resolved = await cached(original);
  resolved!.metadata!.lastActivityAt = 99;
  await cached(original);
  const replacement = { ...original, targetSessionKey: "agent:main:replacement" };
  await bindRecord({ record: replacement });
  await cached(replacement);
  await touch(original, 100);
  const touched = { ...replacement, metadata: { ...replacement.metadata, lastActivityAt: 100 } };
  await cached(touched);
  const sibling = record("sibling");
  updateRecord(sibling.conversation, () => sibling);
  await cached(touched);
  await removeRecords({ conversation: original.conversation, bindingId: original.bindingId });
  await cached(null);
});
it("keeps a prepared selection current after a completed no-op worker resolve", async () => {
  openOpenClawStateDatabase();
  const conversation = internalConversation("missing-prepared");
  const prepared = await prepare(conversation);
  const changes: string[] = [];
  const unsubscribe = publication.subscribeFacts((change) => {
    changes.push(
      "receipt" in change
        ? "receipt"
        : change.kind === "settled"
          ? (change.outcome ?? "unknown")
          : change.kind,
    );
  });
  onTestFinished(unsubscribe);
  expect(prepared.inspect()).toMatchObject([{ status: "available", binding: null }]);
  expect(await resolveRecord(conversation)).toBeNull();
  expect(changes).toEqual(["pending", "unchanged"]);
  expect(prepared.inspect()).toMatchObject([{ status: "available", binding: null }]);
  prepared.dispose();
  expect(() => prepared.inspect()).toThrow("no longer active");
});

it("invalidates prepared effect ownership after committed binding replacement and deletion", async () => {
  const conversation = internalConversation("prepared");
  const original = await bindGeneric({
    conversation,
    targetSessionKey: "agent:main:original",
    targetKind: "session",
  });
  expect(original).not.toBeNull();
  const prepared = await prepare(conversation);
  const sql = observeHostDataSql();
  try {
    expect(prepared.inspect()).toMatchObject([{ binding: original }]);
  } finally {
    sql.restore();
  }
  expect(sql.queries).toEqual([]);
  const replacement = { ...original!, targetSessionKey: "agent:main:replacement" };
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
] as const)(
  "rolls back $operation when authority expires at $stage",
  async ({ operation, stage }) => {
    const service = getSessionBindingService();
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
    expect(active).toBe(false);
    expect(row.get(original.bindingId)).toEqual(before);
    expect(await service.resolveByConversationAsync(conversation)).toEqual(original);
  },
);
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
    if (!original) {
      throw new Error("Missing fixture account binding");
    }
    const row = bindingRows("record_json, metadata_json, expires_at");
    const at = original.boundAt + 1_000;
    manager.touchConversation("thread", at);
    const expected = row.get(original.bindingId);
    updateRecord(ref, () => original);
    const service = getSessionBindingService();
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
    updateRecord(bound.conversation, () => ({
      ...bound,
      expiresAt: 1,
    }));
    const query = bindingRows();
    const before = query.get(bound.bindingId);
    expect(before).toBeDefined();
    let retirements = 0;
    probe.admission(admission, (request, grant, admit) => {
      if (request.stage === "transaction") {
        retirements += 1;
        manager.stop();
      }
      admit(request, grant);
    });
    await expect(
      resolveBoundDeliveryDestination({ targetSessionKey: bound.targetSessionKey }),
    ).rejects.toMatchObject({ code: "BINDING_ADAPTER_UNAVAILABLE" });
    expect(retirements).toBe(1);
    expect(query.get(bound.bindingId)).toEqual(before);
  } finally {
    vi.restoreAllMocks();
    manager.stop();
  }
});

it.each(["replaced", "removed", "expired", "malformed"] as const)(
  "refreshes every batched session after a foreign binding is %s before expiry pruning",
  async (change) => {
    const expired = {
      ...record("expired-batch"),
      targetSessionKey: "agent:main:expired",
      expiresAt: 1,
    };
    const original = { ...record("valid-batch"), targetSessionKey: "agent:main:valid" };
    for (const value of [expired, original]) {
      updateRecord(value.conversation, () => value);
    }
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
      const row = database.db.prepare(
        "SELECT record_json FROM current_conversation_bindings WHERE binding_id = ?",
      );
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

it("binds, refreshes and removes generic and account-owned rows without caller-thread SQL", async () => {
  const manager = createManager(managerOptions());
  const service = getSessionBindingService();
  openOpenClawStateDatabase();
  const hostSql = observeHostDataSql();
  onTestFinished(() => hostSql.restore());
  onTestFinished(() => manager.stop());
  for (const channel of [INTERNAL_MESSAGE_CHANNEL, "fixture"]) {
    const conversation = { channel, accountId: "owner", conversationId: "bound" };
    const initial = await bindSession(conversation, "agent:main:bound", {
      label: "original",
      cleared: "old value",
      opaque: { retained: true },
    });
    const refreshed = await bindSession(conversation, initial.targetSessionKey, {
      label: "refreshed",
      cleared: undefined,
    });
    expect(refreshed.metadata).toMatchObject({
      label: "refreshed",
      opaque: { retained: true },
    });
    expect(refreshed.metadata?.cleared).toBeUndefined();
    expect(await service.resolveByConversationAsync(conversation)).toEqual(refreshed);
    expect(
      await service.unbind({
        bindingId: refreshed.bindingId,
        scope: conversation,
        reason: "test",
      }),
    ).toEqual([refreshed]);
    expect(await service.resolveByConversationAsync(conversation)).toBeNull();
    const rebound = await bindSession(conversation, initial.targetSessionKey);
    const listing = await listSessionBindingsBySessionsAsync([
      rebound.targetSessionKey,
      "agent:main:absent",
    ]);
    expect(listing.get(rebound.targetSessionKey)).toEqual([rebound]);
    expect(listing.get("agent:main:absent")).toEqual([]);
    expect(
      await service.unbind({
        targetSessionKey: rebound.targetSessionKey,
        scope: conversation,
        reason: "test",
      }),
    ).toEqual([rebound]);
  }
  expect(hostSql.queries).toEqual([]);
});

it.each(["bind", "unbind"] as const)(
  "preserves a replacement row when a prepared %s reaches the worker",
  async (mutation) => {
    const service = getSessionBindingService();
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
  expect(publications).toHaveLength(1);
  expect([...publications[0]!.receipt.facts.values()]).toEqual([
    { kind: "postimage", value: bound },
  ]);
  const touched = await touch(original, 50);
  expect(touched?.metadata?.lastActivityAt).toBe(50);
  expect([...publications.at(-1)!.receipt.facts.values()]).toEqual([
    { kind: "postimage", value: touched },
  ]);
  const expired = ["expired-one", "expired-two"].map((id) =>
    Object.assign(record(id), { expiresAt: 1 }),
  );
  for (const value of expired) {
    updateRecord(value.conversation, () => value);
  }
  publications.length = 0;
  expect(await listRecords([original.targetSessionKey], original.conversation)).toEqual([
    [touched],
  ]);
  expect(publications).toHaveLength(1);
  expect([...publications[0]!.receipt.facts.values()]).toEqual([
    { kind: "absent" },
    { kind: "absent" },
  ]);
  expect(publications[0]!.sessionKeys).toEqual([original.targetSessionKey]);
  expect(await removeRecords({ conversation: original.conversation })).toEqual([touched]);
  expect([...publications.at(-1)!.receipt.facts.values()]).toEqual([{ kind: "absent" }]);
});

it("cannot restore a newer native deletion when a committed worker receipt arrives late", async () => {
  const original = record("late-receipt");
  updateRecord(original.conversation, () => original);
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
  expect(publications).toHaveLength(2);
  expect([...publications[0]!.receipt.facts.values()]).toEqual([{ kind: "absent" }]);
  expect([...publications[1]!.receipt.facts.values()]).toEqual([{ kind: "unknown" }]);
});

it("retires binding coverage after unknown native settlement", async () => {
  const original = record("unknown-settlement");
  const nativeOutcomes: string[] = [];
  const outcomes: string[] = [];
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
  const unsubscribe = publication.subscribeFacts((change) => {
    if ("kind" in change && change.kind === "settled") {
      outcomes.push(change.outcome ?? "missing");
    }
  });
  onTestFinished(() => unsubscribe());
  await bindRecord({ record: original });
  expect(await inspectRecord(original.conversation)).toEqual(original);
  expect(nativeOutcomes).toEqual(["completed"]);
  expect(outcomes.at(-1)).toBe("unknown");
});

it("commits oversized expiry batches and retires binding coverage before replying", async () => {
  // Short record IDs keep only the real conversation keys responsible for receipt overflow.
  const suffix = "x".repeat(SQLITE_WORKER_MAX_MESSAGE_BYTES / 16);
  for (let index = 0; index < 17; index++) {
    const expired = record(`${index}:${suffix}`);
    expired.bindingId = `expired-${index}`;
    expired.expiresAt = 1;
    updateRecord(expired.conversation, () => expired);
  }
  const { db } = openOpenClawStateDatabase();
  expect(db.prepare("SELECT count(*) AS count FROM current_conversation_bindings").get()).toEqual({
    count: 17,
  });
  const events: string[] = [];
  const unsubscribe = publication.subscribeFacts((change) => {
    if ("kind" in change) {
      events.push(change.kind);
    }
  });
  onTestFinished(() => unsubscribe());
  await expect(
    listRecords(["agent:main:current"], {
      channel: "fixture",
      accountId: "default",
    }),
  ).resolves.toEqual([[]]);
  events.push("reply");
  expect(db.prepare("SELECT count(*) AS count FROM current_conversation_bindings").get()).toEqual({
    count: 0,
  });
  expect(events).toEqual(["pending", "unknown", "settled", "reply"]);
});

it("runs the V2 account manager's complete persistence lifecycle in workers", async () => {
  const manager = createManagerV2(
    managerOptions({
      cfg: { session: { threadBindings: { idleHours: 0, maxAgeHours: 0 } } },
    }),
  );
  for (const method of [
    "getByConversationId",
    "listBySessionKey",
    "bindConversation",
    "touchConversation",
    "unbindConversation",
    "unbindBySessionKey",
  ]) {
    expect(manager).not.toHaveProperty(method);
  }
  openOpenClawStateDatabase();
  const hostSql = observeHostDataSql();
  onTestFinished(() => hostSql.restore());
  onTestFinished(() => manager.stop());
  const binding = await manager.bindConversationAsync({
    conversationId: "room",
    targetSessionKey: "agent:main:managed",
    targetKind: "session",
    metadata: { label: "worker-owned" },
  });
  expect(binding).toMatchObject({ conversationId: "room", label: "worker-owned" });
  expect(await manager.getByConversationIdAsync("room")).toEqual(binding);
  expect(await manager.listBySessionKeyAsync("agent:main:managed")).toEqual([binding]);
  expect(await manager.touchConversationAsync("room", 123)).toMatchObject({
    lastActivityAt: 123,
  });
  expect(await manager.unbindConversationAsync("room")).toMatchObject({ lastActivityAt: 123 });
  expect(await manager.getByConversationIdAsync("room")).toBeUndefined();
  await manager.bindConversationAsync({
    conversationId: "room",
    targetSessionKey: "agent:main:managed",
    targetKind: "session",
  });
  expect(await manager.unbindBySessionKeyAsync("agent:main:managed")).toHaveLength(1);
  expect(await manager.listBySessionKeyAsync("agent:main:managed")).toEqual([]);
  expect(hostSql.queries).toEqual([]);
  manager.stop();
  await expect(
    manager.bindConversationAsync({
      conversationId: "closed",
      targetSessionKey: "agent:main:managed",
      targetKind: "session",
    }),
  ).rejects.toThrow("no longer active");
});
