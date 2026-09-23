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
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as admission from "../sqlite-worker-operation-admission.js";
import { createAccountScopedConversationBindingManager } from "./account-scoped-conversation-bindings.js";
import {
  inspectCurrentConversationBindingRecordAsync,
  readCurrentConversationBindingSelectionAsync,
  readGenericCurrentConversationBindingSelectionAsync,
  resolveCurrentConversationBindingRecordAsync,
  touchCurrentConversationBindingRecordAsync,
  updateCurrentConversationBindingRecord,
} from "./current-conversation-bindings.js";
import {
  getSessionBindingService,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
} from "./session-binding-service.js";
import type { SessionBindingRecord } from "./session-binding.types.js";

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
      const createAdmission = admission.createSqliteWorkerOperationAdmission;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation((admit) =>
        createAdmission((request, grant) => {
          if (request.stage === stage) {
            active = false;
          }
          admit(request, grant);
        }),
      );
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
