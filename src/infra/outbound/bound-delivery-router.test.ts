// Covers bound delivery routing for active bindings, requester matching,
// ambiguous bindings, and fail-closed fallback reasons.
import fs from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel-constants.js";
import { createAccountScopedConversationBindingManager } from "./account-scoped-conversation-bindings.js";
import { createBoundDeliveryRouter } from "./bound-delivery-router.js";
import {
  testing,
  getSessionBindingService,
  registerSessionBindingAdapter,
  type SessionBindingRecord,
} from "./session-binding-service.js";

const TARGET_SESSION_KEY = "agent:main:subagent:child";

function createRuntimeBinding(
  targetSessionKey: string,
  conversationId: string,
  boundAt: number,
  parentConversationId?: string,
): SessionBindingRecord {
  return {
    bindingId: `runtime:${conversationId}`,
    targetSessionKey,
    targetKind: "subagent",
    conversation: {
      channel: "richchat",
      accountId: "runtime",
      conversationId,
      parentConversationId,
    },
    status: "active",
    boundAt,
  };
}

function registerRuntimeSessionBindings(
  targetSessionKey: string,
  bindings: SessionBindingRecord[],
): void {
  registerSessionBindingAdapter({
    channel: "richchat",
    accountId: "runtime",
    listBySession: (requestedSessionKey) =>
      requestedSessionKey === targetSessionKey ? bindings : [],
    resolveByConversation: () => null,
  });
}

describe("bound delivery router", () => {
  beforeEach(() => {
    testing.resetSessionBindingAdaptersForTests();
  });

  const resolveDestination = (params: {
    targetSessionKey?: string;
    bindings?: SessionBindingRecord[];
    requesterConversationId?: string;
    failClosed?: boolean;
  }) => {
    if (params.bindings) {
      registerRuntimeSessionBindings(
        params.targetSessionKey ?? TARGET_SESSION_KEY,
        params.bindings,
      );
    }
    return createBoundDeliveryRouter().resolveDestination({
      eventKind: "task_completion",
      targetSessionKey: params.targetSessionKey ?? TARGET_SESSION_KEY,
      ...(params.requesterConversationId !== undefined
        ? {
            requester: {
              channel: "richchat",
              accountId: "runtime",
              conversationId: params.requesterConversationId,
            },
          }
        : {}),
      failClosed: params.failClosed ?? false,
    });
  };

  it.each([
    {
      name: "resolves to a bound destination when a single active binding exists",
      bindings: [createRuntimeBinding(TARGET_SESSION_KEY, "thread-1", 1, "parent-1")],
      requesterConversationId: "parent-1",
      expected: {
        mode: "bound",
      },
      expectedConversationId: "thread-1",
    },
    {
      name: "falls back when no active binding exists",
      targetSessionKey: "agent:main:subagent:missing",
      requesterConversationId: "parent-1",
      expected: {
        binding: null,
        mode: "fallback",
        reason: "no-active-binding",
      },
    },
    {
      name: "fails closed when requester signal is missing even with a single binding",
      bindings: [createRuntimeBinding(TARGET_SESSION_KEY, "thread-1", 1)],
      failClosed: true,
      expected: {
        binding: null,
        mode: "fallback",
        reason: "missing-requester",
      },
    },
    {
      name: "normalizes adapter binding conversations before requester matching",
      bindings: [
        {
          ...createRuntimeBinding(TARGET_SESSION_KEY, "thread-1", 1),
          conversation: {
            channel: " richchat ",
            accountId: " runtime ",
            conversationId: " thread-1 ",
          },
        },
        {
          ...createRuntimeBinding(TARGET_SESSION_KEY, "thread-2", 2),
          conversation: {
            channel: " RICHCHAT ",
            accountId: " Runtime ",
            conversationId: " thread-2 ",
          },
        },
      ],
      requesterConversationId: "thread-2",
      failClosed: true,
      expected: {
        mode: "bound",
        reason: "requester-match",
      },
      expectedConversationId: " thread-2 ",
    },
    {
      name: "falls back for invalid requester conversation values",
      bindings: [createRuntimeBinding(TARGET_SESSION_KEY, "thread-1", 1)],
      requesterConversationId: " ",
      failClosed: true,
      expected: {
        binding: null,
        mode: "fallback",
        reason: "invalid-requester",
      },
    },
  ])(
    "$name",
    async ({
      targetSessionKey,
      bindings,
      requesterConversationId,
      failClosed,
      expected,
      expectedConversationId,
    }) => {
      const route = await resolveDestination({
        targetSessionKey,
        bindings,
        requesterConversationId,
        failClosed,
      });

      for (const [key, value] of Object.entries(expected)) {
        expect((route as Record<string, unknown>)[key]).toEqual(value);
      }
      if (expectedConversationId !== undefined) {
        expect(route.binding?.conversation.conversationId).toBe(expectedConversationId);
      }
    },
  );
});

it("lists account and generic destinations and prunes expiry without host SQL", async () => {
  await withOpenClawTestState({ label: "bound-destination-worker-list" }, async () => {
    testing.resetSessionBindingAdaptersForTests();
    const manager = createAccountScopedConversationBindingManager({
      channel: "fixture",
      accountId: "owner",
      cfg: {},
      stateKey: Symbol("binding-list"),
      toStoredTargetKind: (kind) => kind,
      toSessionBindingTargetKind: (kind) => kind,
    });
    try {
      manager.bindConversation({
        conversationId: "owned-room",
        targetSessionKey: TARGET_SESSION_KEY,
        targetKind: "session",
      });
      const service = getSessionBindingService();
      const generic = await service.bind({
        conversation: {
          channel: INTERNAL_MESSAGE_CHANNEL,
          accountId: "default",
          conversationId: "generic-room",
        },
        targetSessionKey: TARGET_SESSION_KEY,
        targetKind: "session",
      });
      const expired = await service.bind({
        conversation: {
          channel: INTERNAL_MESSAGE_CHANNEL,
          accountId: "default",
          conversationId: "expired-room",
        },
        targetSessionKey: TARGET_SESSION_KEY,
        targetKind: "session",
        ttlMs: 0,
      });
      const { db } = openOpenClawStateDatabase();
      const row = db.prepare(
        "SELECT record_json FROM current_conversation_bindings WHERE binding_id = ?",
      );
      expect(row.get(expired.bindingId)).toBeDefined();
      const genericBefore = row.get(generic.bindingId);
      const hostSql = observeHostDataSql();
      try {
        const route = await createBoundDeliveryRouter().resolveDestination({
          eventKind: "task_completion",
          targetSessionKey: TARGET_SESSION_KEY,
          failClosed: true,
          requester: { channel: "fixture", accountId: "owner", conversationId: "owned-room" },
        });
        expect(route).toMatchObject({
          mode: "bound",
          reason: "requester-match",
          binding: { bindingId: "owner:owned-room" },
        });
        for (const call of hostSql.calls) {
          expect(call).not.toHaveBeenCalled();
        }
      } finally {
        hostSql.restore();
      }
      expect(row.get(expired.bindingId)).toBeUndefined();
      expect(row.get(generic.bindingId)).toEqual(genericBefore);
    } finally {
      manager.stop();
    }
  });
});

it("creates the binding store on the first destination lookup without host SQL", async () => {
  testing.resetSessionBindingAdaptersForTests();
  await withOpenClawTestState({ label: "bound-destination-cold-list" }, async () => {
    const databasePath = resolveOpenClawStateSqlitePath();
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    const hostSql = observeHostDataSql();
    try {
      expect(
        await createBoundDeliveryRouter().resolveDestination({
          eventKind: "task_completion",
          targetSessionKey: TARGET_SESSION_KEY,
          failClosed: true,
        }),
      ).toEqual({ binding: null, mode: "fallback", reason: "no-active-binding" });
      for (const call of hostSql.calls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      hostSql.restore();
    }
    expect((await fs.stat(databasePath)).isFile()).toBe(true);
    const { db } = openOpenClawStateDatabase();
    expect(db.prepare("SELECT COUNT(*) AS count FROM current_conversation_bindings").get()).toEqual(
      {
        count: 0,
      },
    );
  });
});
