import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConversationRef } from "../../routing/conversation-ref.js";
import {
  beginConversationDeliveryOperation,
  ConversationDeliveryInputError,
  findConversationTurnDeliveryByReplyTarget,
  getConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliveryReplied,
  markConversationDeliverySent,
} from "./conversation-delivery-store.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "./session-actor-storage-binding.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory conversation delivery opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory conversation delivery allocated a worker");
  }),
}));

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const sessionKey = "agent:main:dashboard:incognito-conversation";
const sessionId = "conversation-1";
const scope = { agentId: "main" };
const conversationRef = buildConversationRef({
  channel: "reef",
  accountId: "default",
  kind: "direct",
  peerId: "peer-agent",
});
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

async function fixture() {
  const path = "/synthetic/memory-conversation";
  const owner = createMemorySessionActorOwner({ agentId: "main", path });
  owners.push(owner);
  const actor = await owner.acquire({ database: owner.identity, sessionKey }, lifetime);
  const binding: SessionActorStorageBinding = { actor, authority, agentId: "main", path };
  const created = await actor.storage!.mutate(
    {
      type: "session.entry.create",
      input: {
        entry: {
          sessionId,
          updatedAt: 1,
          chatType: "direct",
          delivery: {
            kind: "external",
            route: { channel: "reef", target: { to: "reef:peer-agent" } },
            context: { channel: "reef", accountId: "default", to: "reef:peer-agent" },
            origin: {
              provider: "reef",
              accountId: "default",
              nativeDirectUserId: "peer-agent",
            },
          },
        },
        cwd: "/synthetic",
      },
    },
    authority,
  );
  expect(created.kind).toBe("committed");
  if (created.kind !== "committed") {
    throw new Error(created.error.message);
  }
  return { owner, actor, binding, entry: created.value };
}

describe("memory conversation delivery store", () => {
  it("shares one receipt across retries and rejects reused input without changing it", async () => {
    const { binding } = await fixture();
    await runWithSessionActorStorage(binding, async () => {
      const input = {
        operationId: "send-1",
        operationKind: "send" as const,
        conversationRef,
        sourceSessionKey: sessionKey,
        message: "hello",
        preparedMessageId: "prepared-1",
      };
      expect(await getConversationDeliveryOperation(scope, "send-1")).toBeUndefined();
      const [first, retry] = await Promise.all([
        beginConversationDeliveryOperation(scope, input),
        beginConversationDeliveryOperation(scope, { ...input, operationId: " send-1 " }),
      ]);
      expect(first.created).toBe(true);
      expect(first.record).toMatchObject({ status: "created", channel: "reef" });
      expect(retry).toEqual({ created: false, record: first.record });
      await expect(
        beginConversationDeliveryOperation(scope, { ...input, message: "different" }),
      ).rejects.toBeInstanceOf(ConversationDeliveryInputError);
      await expect(
        getConversationDeliveryOperation(scope, "send-1", { ...input, message: "different" }),
      ).rejects.toBeInstanceOf(ConversationDeliveryInputError);
      expect(await getConversationDeliveryOperation(scope, "send-1", input)).toEqual(first.record);
      first.record.status = "replied";
      expect(await getConversationDeliveryOperation(scope, "send-1")).toMatchObject({
        status: "created",
      });
    });
  });

  it("publishes transitions immediately and keeps a late send callback from regressing a reply", async () => {
    const { binding } = await fixture();
    await runWithSessionActorStorage(binding, async () => {
      await beginConversationDeliveryOperation(scope, {
        operationId: "turn-1",
        operationKind: "turn",
        conversationRef,
        message: "question",
        preparedMessageId: "prepared-1",
      });
      const queued = await markConversationDeliveryQueued(scope, "turn-1", "queue-1");
      expect(
        await findConversationTurnDeliveryByReplyTarget(scope, {
          conversationRef,
          replyToId: "prepared-1",
        }),
      ).toEqual(queued);
      const sent = await markConversationDeliverySent(scope, "turn-1", "platform-1");
      expect(await getConversationDeliveryOperation(scope, "turn-1")).toEqual(sent);
      const replied = await markConversationDeliveryReplied(scope, {
        operationId: "turn-1",
        session: { sessionKey, sessionId },
        reply: {
          messageId: "reply-1",
          replyToId: "platform-1",
          text: "answer",
          timestamp: 100,
        },
      });
      expect(replied).toMatchObject({ status: "replied", reply: { text: "answer" } });
      expect(await markConversationDeliverySent(scope, "turn-1", "late-platform")).toEqual(replied);
      expect(
        await findConversationTurnDeliveryByReplyTarget(scope, {
          conversationRef,
          replyToId: "platform-1",
        }),
      ).toEqual(replied);
      expect(queued.status).toBe("queued");
    });
  });

  it("refuses captured replies to a replaced conversation and retains effect-time authority", async () => {
    const { owner, actor, binding, entry } = await fixture();
    await runWithSessionActorStorage(binding, async () => {
      await beginConversationDeliveryOperation(scope, {
        operationId: "turn-reset",
        operationKind: "turn",
        conversationRef,
        message: "question",
      });
      await markConversationDeliveryQueued(scope, "turn-reset", "queue-reset");
    });
    const reset = await actor.storage!.mutate(
      {
        type: "session.lifecycle.reset",
        input: {
          expected: entry,
          nextEntry: { ...entry, sessionId: "conversation-2", lifecycleRevision: "reset-2" },
        },
      },
      authority,
    );
    expect(reset.kind).toBe("committed");
    const replacement = await owner.acquire({ database: owner.identity, sessionKey }, lifetime);
    await runWithSessionActorStorage({ ...binding, actor: replacement }, async () => {
      const params = {
        operationId: "turn-reset",
        reply: { messageId: "reply-reset", text: "answer", timestamp: 200 },
      };
      await expect(
        markConversationDeliveryReplied(scope, { ...params, session: { sessionKey, sessionId } }),
      ).rejects.toThrow("session changed before captured reply persistence");
      await expect(
        markConversationDeliveryReplied(scope, params, () => {
          throw new Error("transport authority revoked");
        }),
      ).rejects.toThrow("transport authority revoked");
      expect(await getConversationDeliveryOperation(scope, "turn-reset")).toMatchObject({
        status: "queued",
      });
      expect(
        await markConversationDeliveryReplied(scope, {
          ...params,
          session: { sessionKey, sessionId: "conversation-2", lifecycleRevision: "reset-2" },
        }),
      ).toMatchObject({ status: "replied", reply: { messageId: "reply-reset" } });
    });
  });
});
