import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConversationRef } from "../../routing/conversation-ref.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
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
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { failSessionActorMemoryPublication } from "./session-actor-memory-publication.test-support.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
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
const env = { OPENCLAW_STATE_DIR: "/synthetic/memory-conversation-delivery" };
const scope = {
  agentId: "main",
  env,
  storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
};
const conversationRef = buildConversationRef({
  channel: "reef",
  accountId: "default",
  kind: "direct",
  peerId: "peer-agent",
});
const sendInput = {
  operationKind: "send" as const,
  conversationRef,
  sourceSessionKey: sessionKey,
  message: "hello",
  preparedMessageId: "prepared-1",
};
const turnInput = { operationKind: "turn" as const, conversationRef, message: "question" };
const delivery = {
  get: getConversationDeliveryOperation.bind(null, scope),
  begin: beginConversationDeliveryOperation.bind(null, scope),
  queue: markConversationDeliveryQueued.bind(null, scope),
  send: markConversationDeliverySent.bind(null, scope),
  reply: markConversationDeliveryReplied.bind(null, scope),
  find: (replyToId: string) =>
    findConversationTurnDeliveryByReplyTarget(scope, { conversationRef, replyToId }),
};
afterEach(() => memorySessionActorOwners.reset());

async function fixture() {
  const binding = (await acquireSessionActorStorage(
    { ...scope, sessionKey },
    { authority, lifetime, create: true },
  ))!;
  const actor = binding.actor;
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
            origin: { provider: "reef", accountId: "default", nativeDirectUserId: "peer-agent" },
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
  return { actor, binding, entry: created.value };
}

describe("memory conversation delivery store", () => {
  it("reports a bound publication failure while retaining the delivery receipt", async () => {
    const { binding } = await fixture();
    const input = {
      ...sendInput,
      operationId: "send-publication",
      preparedMessageId: "prepared-publication",
    };
    const stop = failSessionActorMemoryPublication(sessionKey);
    try {
      await expect(
        runWithSessionActorStorage(binding, () => delivery.begin(input)),
      ).rejects.toMatchObject({ name: "SessionActorStorageCommittedError" });
    } finally {
      stop();
    }
    expect(await delivery.get(input.operationId)).toMatchObject({
      status: "created",
      preparedMessageId: input.preparedMessageId,
    });
    expect(await delivery.begin(input)).toMatchObject({ created: false });
  });

  it("shares one receipt across retries and rejects reused input without changing it", async () => {
    await fixture();
    const input = { ...sendInput, operationId: "send-1" };
    expect(await delivery.get("send-1")).toBeUndefined();
    const [first, retry] = await Promise.all([
      delivery.begin(input),
      delivery.begin({ ...input, operationId: " send-1 " }),
    ]);
    expect(first.created).toBe(true);
    expect(first.record).toMatchObject({ status: "created", channel: "reef" });
    expect(retry).toEqual({ created: false, record: first.record });
    await expect(delivery.begin({ ...input, message: "different" })).rejects.toBeInstanceOf(
      ConversationDeliveryInputError,
    );
    await expect(delivery.get("send-1", { ...input, message: "different" })).rejects.toBeInstanceOf(
      ConversationDeliveryInputError,
    );
    expect(await delivery.get("send-1", input)).toEqual(first.record);
    first.record.status = "replied";
    expect(await delivery.get("send-1")).toMatchObject({ status: "created" });
  });

  it("publishes transitions immediately and keeps a late send callback from regressing a reply", async () => {
    const { actor } = await fixture();
    await delivery.begin({ ...turnInput, operationId: "turn-1", preparedMessageId: "prepared-1" });
    const queued = await delivery.queue("turn-1", "queue-1");
    expect(await delivery.find("prepared-1")).toEqual(queued);
    const sent = await delivery.send("turn-1", "platform-1");
    expect(await delivery.get("turn-1")).toEqual(sent);
    const replied = await delivery.reply({
      operationId: "turn-1",
      session: { sessionKey, sessionId },
      reply: { messageId: "reply-1", replyToId: "platform-1", text: "answer", timestamp: 100 },
    });
    expect(replied).toMatchObject({ status: "replied", reply: { text: "answer" } });
    expect(await delivery.send("turn-1", "late-platform")).toEqual(replied);
    expect(await delivery.find("platform-1")).toEqual(replied);
    expect(queued.status).toBe("queued");
    expect(
      (await actor.storage.mutate({ type: "session.lifecycle.delete", input: {} }, authority)).kind,
    ).toBe("committed");
    expect(await delivery.get("turn-1")).toEqual(replied);
    memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: scope.storePath });
    expect(await delivery.get("turn-1")).toBeUndefined();
  });

  it("refuses captured replies to a replaced conversation and retains effect-time authority", async () => {
    const { actor, entry } = await fixture();
    await delivery.begin({ ...turnInput, operationId: "turn-reset" });
    await delivery.queue("turn-reset", "queue-reset");
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
    const params = {
      operationId: "turn-reset",
      reply: { messageId: "reply-reset", text: "answer", timestamp: 200 },
    };
    await expect(delivery.reply({ ...params, session: { sessionKey, sessionId } })).rejects.toThrow(
      "session changed before captured reply persistence",
    );
    await expect(
      delivery.reply(params, () => {
        throw new Error("transport authority revoked");
      }),
    ).rejects.toThrow("transport authority revoked");
    expect(await delivery.get("turn-reset")).toMatchObject({ status: "queued" });
    expect(
      await delivery.reply({
        ...params,
        session: { sessionKey, sessionId: "conversation-2", lifecycleRevision: "reset-2" },
      }),
    ).toMatchObject({ status: "replied", reply: { messageId: "reply-reset" } });
  });
});
