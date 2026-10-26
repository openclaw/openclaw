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
const conversation = (conversationId: string) => ({
  channel: "richchat",
  accountId: "runtime",
  conversationId,
});

function createRuntimeBinding(
  conversationId: string,
  overrides: Partial<SessionBindingRecord["conversation"]> = {},
): SessionBindingRecord {
  return {
    bindingId: `runtime:${conversationId}`,
    targetSessionKey: TARGET_SESSION_KEY,
    targetKind: "subagent",
    conversation: { ...conversation(conversationId), ...overrides },
    status: "active",
    boundAt: 1,
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

const normalizedBindings = [
  createRuntimeBinding(" t1 ", { channel: " richchat ", accountId: " runtime " }),
  createRuntimeBinding(" t2 ", { channel: " RICHCHAT ", accountId: " Runtime " }),
];
type RouteCase = { bindings: SessionBindingRecord[]; requester?: string; expected: string | null };
it.each`
  name                     | bindings                                                            | requester    | expected
  ${"single binding"}      | ${[createRuntimeBinding("t1", { parentConversationId: "parent" })]} | ${"parent"}  | ${"t1"}
  ${"missing requester"}   | ${[createRuntimeBinding("t1")]}                                     | ${undefined} | ${null}
  ${"normalized matching"} | ${normalizedBindings}                                               | ${"t2"}      | ${" t2 "}
  ${"invalid requester"}   | ${[createRuntimeBinding("t1")]}                                     | ${" "}       | ${null}
`("resolves $name", async ({ bindings, requester, expected }: RouteCase) => {
  registerSessionBindingAdapter({
    channel: "richchat",
    accountId: "runtime",
    listBySession: (key) => (key === TARGET_SESSION_KEY ? bindings : []),
    resolveByConversation: () => null,
  });
  const route = await resolveBoundDeliveryDestination({
    targetSessionKey: TARGET_SESSION_KEY,
    requester: requester === undefined ? undefined : conversation(requester),
  });

  expect(route && route.conversation.conversationId).toBe(expected);
});

it("creates the store cold, then lists destinations and prunes expiry without host SQL", async () => {
  await withOpenClawTestState({ label: "bound-destination-worker-list" }, async () => {
    const databasePath = resolveOpenClawStateSqlitePath();
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await withoutHostSql(async () => {
      expect(
        await resolveBoundDeliveryDestination({
          targetSessionKey: TARGET_SESSION_KEY,
          requester: conversation("unbound"),
        }),
      ).toBeNull();
    });
    expect((await fs.stat(databasePath)).isFile()).toBe(true);
    const { db } = openOpenClawStateDatabase();
    expect(db.prepare("SELECT COUNT(*) AS count FROM current_conversation_bindings").get()).toEqual(
      { count: 0 },
    );
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
