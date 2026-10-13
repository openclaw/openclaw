import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
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
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel-constants.js";
import { requireNodeSqlite } from "../node-sqlite.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../sqlite-worker-contract.js";
import * as admission from "../sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../sqlite-worker-owner-probe.test-support.js";
import { createAccountScopedConversationBindingManager } from "./account-scoped-conversation-bindings.js";
import { resolveBoundDeliveryDestination } from "./bound-delivery-router.js";
import {
  bindCurrentConversationRecordAsync,
  listCurrentConversationBindingRecordsBySessionsAsync,
  removeCurrentConversationBindingsAsync,
  inspectCurrentConversationBindingRecordAsync,
  readCurrentConversationBindingSelectionAsync,
  readGenericCurrentConversationBindingSelectionAsync,
  resolveCurrentConversationBindingRecordAsync,
  touchCurrentConversationBindingRecordAsync,
  updateCurrentConversationBindingRecord,
} from "./current-conversation-bindings.js";
import { updateCurrentConversationBindingRecordInDatabase } from "./current-conversation-bindings.kernel.js";
import { currentConversationBindingPublication } from "./current-conversation-bindings.publication.js";
import { conversationBindingOperations } from "./current-conversation-bindings.worker.js";
import { expectedCurrentSessionBinding } from "./session-binding-native-selection.js";
import {
  getSessionBindingService,
  listSessionBindingsBySessionsAsync,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
} from "./session-binding-service.js";
import type { SessionBindingRecord } from "./session-binding.types.js";

type CurrentConversationBindingPublication = Parameters<
  Parameters<typeof currentConversationBindingPublication.subscribe>[0]
>[0];

afterEach(() => vi.restoreAllMocks());

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

it.each(["missing", "unsupported", "disabled"] as const)(
  "fences %s generic support when the registry changes during an ordered selection",
  async (mode) => {
    const previousRegistry = captureActivePluginRegistrySnapshot();
    try {
      await withOpenClawTestState({ label: `binding-selection-${mode}` }, async () => {
        const conversation = {
          channel: "selection-fixture",
          accountId: "default",
          conversationId: "higher-priority-child",
        };
        const registry = (supported: boolean) =>
          createTestRegistry([
            {
              pluginId: conversation.channel,
              source: "test",
              plugin: {
                id: conversation.channel,
                meta: { aliases: [] },
                conversationBindings: { supportsCurrentConversationBinding: supported },
              },
            },
          ]);
        const service = getSessionBindingService();
        setActivePluginRegistry(registry(true));
        const bound = await service.bind({
          conversation,
          targetSessionKey: "agent:main:child",
          targetKind: "session",
        });
        expect(await readGenericCurrentConversationBindingSelectionAsync([conversation])).toEqual([
          bound,
        ]);
        let eligibilityCalls = 0;
        setActivePluginRegistry(
          mode === "missing"
            ? createTestRegistry([])
            : mode === "unsupported"
              ? registry(false)
              : createTestRegistry([
                  {
                    pluginId: conversation.channel,
                    source: "test",
                    plugin: {
                      id: conversation.channel,
                      meta: { aliases: [] },
                      conversationBindings: {
                        supportsCurrentConversationBinding: true,
                        isCurrentConversationBindingSupported: () => {
                          eligibilityCalls += 1;
                          return false;
                        },
                      },
                    },
                  },
                ]),
        );
        expect(await readGenericCurrentConversationBindingSelectionAsync([conversation])).toEqual([
          null,
        ]);
        eligibilityCalls = 0;
        const pending = readGenericCurrentConversationBindingSelectionAsync([conversation]);
        setActivePluginRegistry(registry(true));
        await expect(pending).rejects.toThrow(
          "Generic conversation binding owner is no longer available",
        );
        expect(eligibilityCalls).toBe(mode === "disabled" ? 1 : 0);
        expect(await service.resolveByConversationAsync(conversation)).toEqual(bound);
      });
    } finally {
      restoreActivePluginRegistrySnapshot(previousRegistry);
    }
  },
);

it("reads an ordered, captured selection without creating or repairing stored bindings", async () => {
  await withOpenClawTestState({ label: "binding-selection-worker" }, async () => {
    const child = record("child");
    const base = record("base");
    const expired = { ...record("expired"), expiresAt: 1 };
    const requestedBase = { ...base.conversation };
    const refs = [child.conversation, expired.conversation, requestedBase];
    expect(await readCurrentConversationBindingSelectionAsync(refs)).toEqual([null, null, null]);
    await expect(fs.stat(resolveOpenClawStateSqlitePath())).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const value of [base, expired]) {
      updateCurrentConversationBindingRecord(value.conversation, () => value);
    }
    const { db } = openOpenClawStateDatabase();
    const before = db
      .prepare("SELECT * FROM current_conversation_bindings ORDER BY binding_key")
      .all();
    const pending = readCurrentConversationBindingSelectionAsync(refs);
    requestedBase.conversationId = "different";
    refs.reverse();
    expect(await pending).toEqual([null, null, base]);
    expect(
      db.prepare("SELECT * FROM current_conversation_bindings ORDER BY binding_key").all(),
    ).toEqual(before);
  });
});

it("selects live binding facts even inside an older retained discovery snapshot", async () => {
  await withOpenClawTestState({ label: "binding-selection-live" }, async () => {
    const child = record("child");
    const base = record("base");
    updateCurrentConversationBindingRecord(base.conversation, () => base);
    await withOpenClawStateDatabaseReadSnapshot(async () => {
      updateCurrentConversationBindingRecord(child.conversation, () => child);
      expect(await inspectCurrentConversationBindingRecordAsync(child.conversation)).toBeNull();
      expect(
        await readCurrentConversationBindingSelectionAsync([child.conversation, base.conversation]),
      ).toEqual([child, base]);
    });
  });
});

it("refuses pending selection publication when its database lifecycle retires", async () => {
  await withOpenClawTestState({ label: "binding-selection-retirement" }, async () => {
    const current = record("retired");
    updateCurrentConversationBindingRecord(current.conversation, () => current);
    const pending = readCurrentConversationBindingSelectionAsync([current.conversation]);
    const refused = expect(pending).rejects.toThrow();
    await closeOpenClawStateDatabaseAsync();
    await refused;
  });
});

it("keeps inspection noncreating and performs durable read, expiry, and scoped touch without host data SQL", async () => {
  await withOpenClawTestState({ label: "binding-worker" }, async () => {
    let current = record("conversation");
    expect(await inspectCurrentConversationBindingRecordAsync(current.conversation)).toBeNull();
    await expect(fs.stat(resolveOpenClawStateSqlitePath())).rejects.toMatchObject({
      code: "ENOENT",
    });

    const expired = { ...record("expired"), expiresAt: 1 };
    const sibling = record("conversation", "sibling");
    for (const value of [current, expired, sibling]) {
      updateCurrentConversationBindingRecord(value.conversation, () => value);
    }
    const { db } = openOpenClawStateDatabase();
    const row = db.prepare("SELECT * FROM current_conversation_bindings WHERE binding_id = ?");
    const before = row.get(expired.bindingId);
    expect(await inspectCurrentConversationBindingRecordAsync(expired.conversation)).toBeNull();
    expect(row.get(expired.bindingId)).toEqual(before);
    const callerConversation = { ...current.conversation, callerContext: () => "host only" };
    expect(await inspectCurrentConversationBindingRecordAsync(callerConversation)).toEqual(current);
    expect(await resolveCurrentConversationBindingRecordAsync(callerConversation)).toEqual(current);
    current = {
      ...current,
      targetSessionKey: "agent:main:replacement",
      metadata: { opaque: { changed: true } },
    };
    updateCurrentConversationBindingRecord(current.conversation, () => current);
    const hostSql = observeHostDataSql();
    try {
      expect(await inspectCurrentConversationBindingRecordAsync(expired.conversation)).toBeNull();
      expect(await resolveCurrentConversationBindingRecordAsync(current.conversation)).toEqual(
        current,
      );
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
      const touched = await touchCurrentConversationBindingRecordAsync({
        conversation: callerConversation,
        bindingId: current.bindingId,
        at,
        accountPolicy: policy,
      });
      expect(touched).toMatchObject({
        expiresAt: current.boundAt + 60_500,
        metadata: { opaque: current.metadata!.opaque, lastActivityAt: at },
      });
      expect(await inspectCurrentConversationBindingRecordAsync(sibling.conversation)).toEqual(
        sibling,
      );
      expect(await resolveCurrentConversationBindingRecordAsync(expired.conversation)).toBeNull();
      for (const call of hostSql.calls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      hostSql.restore();
    }
    expect(row.get(expired.bindingId)).toBeUndefined();
    // A mismatched binding id cannot mutate a replacement target's metadata.
    await touchCurrentConversationBindingRecordAsync({
      conversation: sibling.conversation,
      bindingId: current.bindingId,
      at: 99,
    });
    expect(await inspectCurrentConversationBindingRecordAsync(sibling.conversation)).toEqual(
      sibling,
    );
  });
});

it.each(["transaction", "commit"] as const)(
  "refuses revoked touch authority at %s and preserves committed bytes",
  async (stage) => {
    await withOpenClawTestState({ label: `binding-worker-${stage}` }, async () => {
      const current = record("revoked");
      updateCurrentConversationBindingRecord(current.conversation, () => current);
      const { db } = openOpenClawStateDatabase();
      const row = db.prepare("SELECT * FROM current_conversation_bindings WHERE binding_id = ?");
      const before = row.get(current.bindingId);
      let active = true;
      probe.admission(admission, (request, grant, admit) => {
        if (request.stage === stage) {
          active = false;
        }
        admit(request, grant);
      });
      await expect(
        touchCurrentConversationBindingRecordAsync(
          { conversation: current.conversation, bindingId: current.bindingId, at: 99 },
          () => {
            if (!active) {
              throw new Error("Binding owner retired");
            }
          },
        ),
      ).rejects.toThrow("Binding owner retired");
      expect(active).toBe(false);
      expect(row.get(current.bindingId)).toEqual(before);
    });
  },
);

it("keeps account touch bytes identical and rejects a manager shadowed by another adapter", async () => {
  await withOpenClawTestState({ label: "account-binding-worker" }, async () => {
    const manager = createAccountScopedConversationBindingManager({
      channel: "fixture",
      accountId: "owner",
      cfg: { session: { threadBindings: { idleHours: 1, maxAgeHours: 2 } } },
      stateKey: Symbol("account-worker"),
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
      const original = await inspectCurrentConversationBindingRecordAsync(ref);
      if (!original) {
        throw new Error("Missing fixture account binding");
      }
      const { db } = openOpenClawStateDatabase();
      const row = db.prepare(
        "SELECT record_json, metadata_json, expires_at FROM current_conversation_bindings WHERE binding_id = ?",
      );
      const at = original.boundAt + 1_000;
      manager.touchConversation("thread", at);
      const expected = row.get(original.bindingId);
      updateCurrentConversationBindingRecord(ref, () => original);
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
});

it.each([
  { stage: "transaction", owner: "manager" },
  { stage: "commit", owner: "registry" },
] as const)(
  "joins expiry pruning refused by the actual $owner at $stage without deleting its row",
  async ({ stage, owner }) => {
    const previousRegistry = captureActivePluginRegistrySnapshot();
    try {
      await withOpenClawTestState({ label: `binding-list-prune-${owner}-${stage}` }, async () => {
        const manager =
          owner === "manager"
            ? createAccountScopedConversationBindingManager({
                channel: "fixture",
                accountId: "owner",
                cfg: {},
                stateKey: Symbol("binding-list-retirement"),
                toStoredTargetKind: (kind) => kind,
                toSessionBindingTargetKind: (kind) => kind,
              })
            : undefined;
        try {
          const service = getSessionBindingService();
          const bound = await service.bind({
            conversation: {
              channel: owner === "manager" ? "fixture" : INTERNAL_MESSAGE_CHANNEL,
              accountId: owner === "manager" ? "owner" : "default",
              conversationId: "expired-list",
            },
            targetSessionKey: "agent:main:current",
            targetKind: "session",
          });
          updateCurrentConversationBindingRecord(bound.conversation, () => ({
            ...bound,
            expiresAt: 1,
          }));
          const { db } = openOpenClawStateDatabase();
          const query = db.prepare(
            "SELECT * FROM current_conversation_bindings WHERE binding_id = ?",
          );
          const before = query.get(bound.bindingId);
          expect(before).toBeDefined();
          let retirements = 0;
          probe.admission(admission, (request, grant, admit) => {
            if (request.stage === stage) {
              retirements += 1;
              if (manager) {
                manager.stop();
              } else {
                setActivePluginRegistry(createTestRegistry([]));
              }
            }
            admit(request, grant);
          });
          await expect(
            resolveBoundDeliveryDestination({
              targetSessionKey: bound.targetSessionKey,
            }),
          ).rejects.toMatchObject({ code: "BINDING_ADAPTER_UNAVAILABLE" });
          expect(retirements).toBe(1);
          expect(query.get(bound.bindingId)).toEqual(before);
        } finally {
          vi.restoreAllMocks();
          manager?.stop();
        }
      });
    } finally {
      restoreActivePluginRegistrySnapshot(previousRegistry);
    }
  },
);

it.each(["replaced", "removed", "expired", "malformed"] as const)(
  "refreshes every batched session after a foreign binding is %s before expiry pruning",
  async (change) => {
    await withOpenClawTestState({ label: `binding-list-foreign-${change}` }, async () => {
      const expired = {
        ...record("expired-batch"),
        targetSessionKey: "agent:main:expired",
        expiresAt: 1,
      };
      const original = { ...record("valid-batch"), targetSessionKey: "agent:main:valid" };
      for (const value of [expired, original]) {
        updateCurrentConversationBindingRecord(value.conversation, () => value);
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
                  updateCurrentConversationBindingRecordInDatabase(
                    foreign,
                    original.conversation,
                    () => (change === "removed" ? null : replacement),
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
    });
  },
);

it("binds, refreshes and removes generic and account-owned rows without caller-thread SQL", async () => {
  await withOpenClawTestState({ label: "binding-mutations-worker" }, async () => {
    const manager = createAccountScopedConversationBindingManager({
      channel: "fixture",
      accountId: "owner",
      cfg: {},
      stateKey: Symbol("binding-mutations"),
      toStoredTargetKind: (kind) => kind,
      toSessionBindingTargetKind: (kind) => kind,
    });
    const service = getSessionBindingService();
    openOpenClawStateDatabase();
    const hostSql = observeHostDataSql();
    try {
      for (const channel of [INTERNAL_MESSAGE_CHANNEL, "fixture"]) {
        const conversation = { channel, accountId: "owner", conversationId: "bound" };
        const initial = await service.bind({
          conversation,
          targetSessionKey: "agent:main:bound",
          targetKind: "session",
          metadata: { label: "original", cleared: "old value", opaque: { retained: true } },
        });
        const refreshed = await service.bind({
          conversation,
          targetSessionKey: initial.targetSessionKey,
          targetKind: "session",
          metadata: { label: "refreshed", cleared: undefined },
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
        const rebound = await service.bind({
          conversation,
          targetSessionKey: initial.targetSessionKey,
          targetKind: "session",
        });
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
      for (const call of hostSql.calls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      hostSql.restore();
      manager.stop();
    }
  });
});

it.each(["transaction", "commit"] as const)(
  "rolls back a binding whose caller authority expires at %s",
  async (stage) => {
    await withOpenClawTestState({ label: `binding-create-${stage}` }, async () => {
      const service = getSessionBindingService();
      const conversation = {
        channel: INTERNAL_MESSAGE_CHANNEL,
        accountId: "default",
        conversationId: "guarded",
      };
      const original = await service.bind({
        conversation,
        targetSessionKey: "agent:main:original",
        targetKind: "session",
      });
      let active = true;
      probe.admission(admission, (request, grant, admit) => {
        if (request.stage === stage) {
          active = false;
        }
        admit(request, grant);
      });
      await expect(
        service.bind({
          conversation,
          targetSessionKey: "agent:main:replacement",
          targetKind: "session",
          assertCurrent: () => {
            if (!active) {
              throw new Error("Binding caller retired");
            }
          },
        }),
      ).rejects.toThrow("Binding caller retired");
      expect(await service.resolveByConversationAsync(conversation)).toEqual(original);
    });
  },
);

it.each(["bind", "unbind"] as const)(
  "preserves a replacement row when a prepared %s reaches the worker",
  async (mutation) => {
    await withOpenClawTestState({ label: `binding-precondition-${mutation}` }, async () => {
      const service = getSessionBindingService();
      const conversation = {
        channel: INTERNAL_MESSAGE_CHANNEL,
        accountId: "default",
        conversationId: "replaced",
      };
      const original = await service.bind({
        conversation,
        targetSessionKey: "agent:main:original",
        targetKind: "session",
      });
      const replacement = await service.bind({
        conversation,
        targetSessionKey: "agent:main:replacement",
        targetKind: "session",
      });
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
    });
  },
);

it("delivers committed worker bind, touch and batch-expiry facts before their replies", async () => {
  await withOpenClawTestState({ label: "binding-worker-receipts" }, async () => {
    const original = record("receipt-worker");
    const publications: CurrentConversationBindingPublication[] = [];
    const unsubscribe = currentConversationBindingPublication.subscribe((publication) =>
      publications.push(publication),
    );
    try {
      const bound = await bindCurrentConversationRecordAsync({ record: original });
      expect(bound).toMatchObject(original);
      expect(publications).toHaveLength(1);
      expect([...publications[0]!.receipt.facts.values()]).toEqual([
        { kind: "postimage", value: bound },
      ]);
      const touched = await touchCurrentConversationBindingRecordAsync({
        conversation: original.conversation,
        bindingId: original.bindingId,
        at: 50,
      });
      expect(touched?.metadata?.lastActivityAt).toBe(50);
      expect([...publications.at(-1)!.receipt.facts.values()]).toEqual([
        { kind: "postimage", value: touched },
      ]);
      const expired = ["expired-one", "expired-two"].map((id) =>
        Object.assign(record(id), { expiresAt: 1 }),
      );
      for (const value of expired) {
        updateCurrentConversationBindingRecord(value.conversation, () => value);
      }
      publications.length = 0;
      expect(
        await listCurrentConversationBindingRecordsBySessionsAsync(
          [original.targetSessionKey],
          original.conversation,
        ),
      ).toEqual([[touched]]);
      expect(publications).toHaveLength(1);
      expect([...publications[0]!.receipt.facts.values()]).toEqual([
        { kind: "absent" },
        { kind: "absent" },
      ]);
      expect(publications[0]!.sessionKeys).toEqual([original.targetSessionKey]);
      expect(
        await removeCurrentConversationBindingsAsync({ conversation: original.conversation }),
      ).toEqual([touched]);
      expect([...publications.at(-1)!.receipt.facts.values()]).toEqual([{ kind: "absent" }]);
    } finally {
      unsubscribe();
    }
  });
});

it("cannot restore a newer native deletion when a committed worker receipt arrives late", async () => {
  await withOpenClawTestState({ label: "binding-late-receipt" }, async () => {
    const original = record("late-receipt");
    updateCurrentConversationBindingRecord(original.conversation, () => original);
    const observe = admission.observeSqliteWorkerCommittedFacts;
    vi.spyOn(admission, "observeSqliteWorkerCommittedFacts").mockImplementation(
      (owner, listener) => {
        observe(owner, (receipt) => {
          updateCurrentConversationBindingRecord(original.conversation, () => null);
          listener(receipt);
        });
      },
    );
    const publications: CurrentConversationBindingPublication[] = [];
    const unsubscribe = currentConversationBindingPublication.subscribe((publication) =>
      publications.push(publication),
    );
    try {
      await touchCurrentConversationBindingRecordAsync({
        conversation: original.conversation,
        bindingId: original.bindingId,
        at: 20,
      });
      expect(await inspectCurrentConversationBindingRecordAsync(original.conversation)).toBeNull();
      expect(publications).toHaveLength(2);
      expect([...publications[0]!.receipt.facts.values()]).toEqual([{ kind: "absent" }]);
      expect([...publications[1]!.receipt.facts.values()]).toEqual([{ kind: "unknown" }]);
    } finally {
      unsubscribe();
    }
  });
});

it("retires binding coverage after unknown native settlement", async () => {
  await withOpenClawTestState({ label: "binding-unknown-settlement" }, async () => {
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
    const unsubscribe = currentConversationBindingPublication.subscribeFacts((change) => {
      if ("kind" in change && change.kind === "settled") {
        outcomes.push(change.outcome ?? "missing");
      }
    });
    try {
      await bindCurrentConversationRecordAsync({ record: original });
      expect(await inspectCurrentConversationBindingRecordAsync(original.conversation)).toEqual(
        original,
      );
      expect(nativeOutcomes).toEqual(["completed"]);
      expect(outcomes.at(-1)).toBe("unknown");
    } finally {
      unsubscribe();
    }
  });
});

it("commits oversized expiry batches and retires binding coverage before replying", async () => {
  await withOpenClawTestState({ label: "binding-large-expiry-receipt" }, async () => {
    // Short record IDs keep only the real conversation keys responsible for receipt overflow.
    const suffix = "x".repeat(SQLITE_WORKER_MAX_MESSAGE_BYTES / 16);
    for (let index = 0; index < 17; index++) {
      const expired = record(`${index}:${suffix}`);
      expired.bindingId = `expired-${index}`;
      expired.expiresAt = 1;
      updateCurrentConversationBindingRecord(expired.conversation, () => expired);
    }
    const { db } = openOpenClawStateDatabase();
    expect(db.prepare("SELECT count(*) AS count FROM current_conversation_bindings").get()).toEqual(
      { count: 17 },
    );
    const events: string[] = [];
    const unsubscribe = currentConversationBindingPublication.subscribeFacts((change) => {
      if ("kind" in change) {
        events.push(change.kind);
      }
    });
    try {
      const outcome = await listCurrentConversationBindingRecordsBySessionsAsync(
        ["agent:main:current"],
        { channel: "fixture", accountId: "default" },
      ).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      events.push("reply");
      expect(
        db.prepare("SELECT count(*) AS count FROM current_conversation_bindings").get(),
      ).toEqual({ count: 0 });
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toEqual([[]]);
      expect(events).toEqual(["pending", "unknown", "settled", "reply"]);
    } finally {
      unsubscribe();
    }
  });
});
