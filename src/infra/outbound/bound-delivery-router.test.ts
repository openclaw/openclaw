import fs from "node:fs/promises";
import { beforeEach, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel-constants.js";
import { createAccountScopedConversationBindingManager } from "./account-scoped-conversation-bindings.js";
import { resolveBoundDeliveryDestination } from "./bound-delivery-router.js";
import {
  testing,
  getSessionBindingService,
  registerSessionBindingAdapter,
  type SessionBindingRecord,
} from "./session-binding-service.js";

const TARGET_SESSION_KEY = "agent:main:subagent:child";

function createRuntimeBinding(
  conversationId: string,
  boundAt = 1,
  conversation: Partial<SessionBindingRecord["conversation"]> = {},
): SessionBindingRecord {
  return {
    bindingId: `runtime:${conversationId}`,
    targetSessionKey: TARGET_SESSION_KEY,
    targetKind: "subagent",
    conversation: { channel: "richchat", accountId: "runtime", conversationId, ...conversation },
    status: "active",
    boundAt,
  };
}

async function withoutHostSql(run: () => Promise<void>) {
  const hostSql = observeHostDataSql();
  try {
    await run();
    for (const call of hostSql.calls) {
      expect(call).not.toHaveBeenCalled();
    }
  } finally {
    hostSql.restore();
  }
}

beforeEach(() => testing.resetSessionBindingAdaptersForTests());

it.each([
  [
    "single binding",
    [createRuntimeBinding("thread-1", 1, { parentConversationId: "parent-1" })],
    "parent-1",
    "thread-1",
  ],
  ["no binding", undefined, "parent-1", undefined],
  ["missing requester", [createRuntimeBinding("thread-1")], undefined, undefined],
  [
    "normalized requester matching",
    [
      createRuntimeBinding(" thread-1 ", 1, { channel: " richchat ", accountId: " runtime " }),
      createRuntimeBinding(" thread-2 ", 2, { channel: " RICHCHAT ", accountId: " Runtime " }),
    ],
    "thread-2",
    " thread-2 ",
  ],
  ["invalid requester", [createRuntimeBinding("thread-1")], " ", undefined],
] satisfies [string, SessionBindingRecord[] | undefined, string | undefined, string | undefined][])(
  "resolves %s",
  async (_name, bindings, requesterConversationId, expectedConversationId) => {
    const targetSessionKey = bindings ? TARGET_SESSION_KEY : "agent:main:subagent:missing";
    if (bindings) {
      registerSessionBindingAdapter({
        channel: "richchat",
        accountId: "runtime",
        listBySession: (key) => (key === targetSessionKey ? bindings : []),
        resolveByConversation: () => null,
      });
    }
    const route = await resolveBoundDeliveryDestination({
      targetSessionKey,
      requester:
        requesterConversationId === undefined
          ? undefined
          : {
              channel: "richchat",
              accountId: "runtime",
              conversationId: requesterConversationId,
            },
    });

    if (expectedConversationId !== undefined) {
      expect(route?.conversation.conversationId).toBe(expectedConversationId);
    } else {
      expect(route).toBeNull();
    }
  },
);

it("lists account and generic destinations and prunes expiry without host SQL", async () => {
  await withOpenClawTestState({ label: "bound-destination-worker-list" }, async () => {
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
      const bind = (conversationId: string, ttlMs?: number) =>
        service.bind({
          conversation: { channel: INTERNAL_MESSAGE_CHANNEL, accountId: "default", conversationId },
          targetSessionKey: TARGET_SESSION_KEY,
          targetKind: "session",
          ...(ttlMs === undefined ? {} : { ttlMs }),
        });
      const generic = await bind("generic-room");
      const expired = await bind("expired-room", 0);
      const { db } = openOpenClawStateDatabase();
      const row = db.prepare(
        "SELECT record_json FROM current_conversation_bindings WHERE binding_id = ?",
      );
      expect(row.get(expired.bindingId)).toBeDefined();
      const genericBefore = row.get(generic.bindingId);
      await withoutHostSql(async () => {
        const route = await resolveBoundDeliveryDestination({
          targetSessionKey: TARGET_SESSION_KEY,
          requester: { channel: "fixture", accountId: "owner", conversationId: "owned-room" },
        });
        expect(route).toMatchObject({ bindingId: "owner:owned-room" });
      });
      expect(row.get(expired.bindingId)).toBeUndefined();
      expect(row.get(generic.bindingId)).toEqual(genericBefore);
    } finally {
      manager.stop();
    }
  });
});

it("creates the binding store on the first destination lookup without host SQL", async () => {
  await withOpenClawTestState({ label: "bound-destination-cold-list" }, async () => {
    const databasePath = resolveOpenClawStateSqlitePath();
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await withoutHostSql(async () => {
      expect(
        await resolveBoundDeliveryDestination({ targetSessionKey: TARGET_SESSION_KEY }),
      ).toBeNull();
    });
    expect((await fs.stat(databasePath)).isFile()).toBe(true);
    const { db } = openOpenClawStateDatabase();
    expect(db.prepare("SELECT COUNT(*) AS count FROM current_conversation_bindings").get()).toEqual(
      { count: 0 },
    );
  });
});
