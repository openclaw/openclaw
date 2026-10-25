import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { assertConversationAuthority } from "./conversation-authority.js";
import {
  beginConversationDeliveryOperation,
  ConversationDeliveryInputError,
  findConversationTurnDeliveryByReplyTarget,
  getConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliveryReplied,
  markConversationDeliverySent,
} from "./conversation-delivery-store.js";
import { conversationEntry, conversationRef } from "./conversation-delivery-store.test-support.js";
import { buildConversationIdentity } from "./conversation-identity.js";
import {
  captureConversationBindingFacts,
  listConversations,
  readConversation,
  registerConversationAddresses,
  resolveCurrentConversationSession,
  resolveCurrentSessionPrimaryConversation,
  withConversationAuthority,
} from "./conversation-registry.js";
import { resolveConversationRouteFingerprint } from "./conversation-route-fingerprint.js";
import type { SessionActor, SessionActorAuthority } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import {
  commitMemory,
  failSessionActorMemoryPublication,
} from "./session-actor-memory-publication.test-support.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
} from "./session-actor-storage-binding.js";
import type { SessionActorStorageWrites } from "./session-actor-storage-contract.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

function mutate<Key extends keyof SessionActorStorageWrites>(
  actor: SessionActor,
  type: Key,
  input: SessionActorStorageWrites[Key]["input"],
) {
  return actor.storage!.mutate({ type, input }, authority);
}
async function commit<Key extends keyof SessionActorStorageWrites>(
  ...args: Parameters<typeof mutate<Key>>
) {
  return readSessionActorStorageResult(await mutate(...args));
}
const patch = (actor: SessionActor, fields: Partial<SessionEntry>) =>
  commit(actor, "session.entry.patch", { operation: { kind: "fields", patch: fields } });

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory conversation opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory conversation allocated a worker");
  }),
}));

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const env = { OPENCLAW_STATE_DIR: "/synthetic/memory-conversation-registry" };
const scope = {
  agentId: "main",
  env,
  storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
};
const sessionKey = "agent:main:dashboard:incognito-conversation-registry";
const read = (ref: string) => readConversation(scope, ref);
const ownerTarget = { agentId: scope.agentId, path: scope.storePath };
const readOwner = () => memorySessionActorOwners.read(ownerTarget)!;
afterEach(() => memorySessionActorOwners.reset());
const primary = (sessionId: string) =>
  resolveCurrentSessionPrimaryConversation({ ...scope, sessionKey, sessionId });
const address = (peerId: string) =>
  buildConversationIdentity({
    channel: "reef",
    kind: "direct",
    peerId,
    deliveryTarget: `reef:${peerId}`,
  })!;

function entry(target: string, updatedAt = 1): SessionEntry {
  return {
    sessionId: "first",
    updatedAt,
    chatType: "channel",
    delivery: {
      kind: "external",
      route: { channel: "discord", target: { to: target } },
      context: { channel: "discord", accountId: "default", to: target },
      origin: { provider: "discord", accountId: "default", chatType: "channel", to: target },
    },
  };
}
async function createMemoryConversation(
  key: string,
  input: SessionActorStorageWrites["session.entry.create"]["input"],
) {
  const acquireBinding = async () =>
    (await acquireSessionActorStorage(
      { ...scope, sessionKey: key },
      { authority, lifetime, create: true },
    ))!;
  const binding = await acquireBinding();
  const actor = binding.actor;
  const created = await commitMemory(actor.storage!, "session.entry.create", input, authority);
  return {
    binding,
    actor,
    created,
    entry: created,
    owner: readOwner(),
    acquire: async () => (await acquireBinding()).actor,
  };
}
const fixture = () =>
  createMemoryConversation(sessionKey, {
    entry: entry("channel:ops"),
    routeContext: { peerId: "canonical-ops", guildId: "guild-a" },
  });

describe("memory conversation registry", () => {
  it("observes a memory owner created after capturing absent conversation authority", async () => {
    const identity = buildConversationIdentity({
      channel: "discord",
      accountId: "default",
      kind: "channel",
      peerId: "canonical-ops",
      deliveryTarget: "channel:ops",
    })!;
    const captured = await captureConversationBindingFacts(scope, [identity.conversationRef]);
    try {
      expect(captured.currentSessionKey(identity.conversationRef)).toBeNull();
      await fixture();
      expect(captured.currentSessionKey(identity.conversationRef)).toBe(sessionKey);
    } finally {
      captured.release();
    }
  });

  it("registers an address catalogue without manufacturing a session", async () => {
    const identity = address("catalogue");
    await registerConversationAddresses(scope, [identity], 1);
    expect(await read(identity.conversationRef)).toHaveProperty("target", "reef:catalogue");
    expect(readOwner().listSessions(authority)).toEqual([]);
  });
  it("retains observed identity through generic writes and changes current bindings at rebind/reset", async () => {
    const { actor, acquire, created } = await fixture();
    const initial = await primary(created.sessionId);
    expect(initial).toMatchObject({
      peerId: "canonical-ops",
      routeContext: { guildId: "guild-a" },
      routeContextObserved: true,
    });
    await commit(actor, "session.lifecycle.reset", {
      expected: created,
      nextEntry: { ...created, updatedAt: 2 },
    });
    const resumed = await read(initial!.conversationRef);
    expect(resumed).toEqual({ ...initial, lastSeenAt: 2 });
    await patch(actor, { totalTokens: 42, updatedAt: 3 });
    expect(await read(initial!.conversationRef)).toEqual(resumed);
    expect(await primary(created.sessionId)).toEqual(resumed);
    const updated = await patch(actor, { label: "renamed", updatedAt: 2 });
    expect(await read(initial!.conversationRef)).toMatchObject({
      conversationRef: initial!.conversationRef,
      peerId: "canonical-ops",
      label: "renamed",
      routeContext: { guildId: "guild-a" },
    });
    const rebound = await commit(actor, "session.entry.replace", {
      expected: updated,
      entry: entry("channel:other", 3),
    });
    expect(resolveCurrentConversationSession(scope, initial!.conversationRef)).toBeUndefined();
    const current = await primary("first");
    expect(current).toMatchObject({ target: "channel:other", role: "primary" });
    expect(await read(initial!.conversationRef)).toHaveProperty("role", "related");
    await commit(actor, "session.lifecycle.reset", {
      expected: rebound,
      nextEntry: { ...rebound!, sessionId: "second", updatedAt: 4 },
    });
    await acquire();
    expect(resolveCurrentConversationSession(scope, current!.conversationRef)).toEqual({
      sessionKey,
      sessionId: "second",
    });
    expect(await primary("first")).toBeUndefined();
  });

  it("uses stored associations for source predicates and the route fingerprint at external effects", async () => {
    const { actor, owner } = await fixture();
    const conversation = (await listConversations(scope))[0]!;
    const expected = {
      conversationRef: conversation.conversationRef,
      expectedRouteFingerprint: resolveConversationRouteFingerprint(conversation),
      expectedSessionId: "first",
      expectedSessionKey: sessionKey,
    };
    const source = {
      source: {
        agentId: scope.agentId,
        path: scope.storePath,
        databaseIdentity: owner.identity.incarnation,
      },
      sessionKey,
      fields: ["sessionId" as const],
      expected: { sessionId: "first" },
      conversationAlternatives: [[{ conversationRef: conversation.conversationRef, sessionKey }]],
    };
    const guardedPatch = () =>
      mutate(actor, "session.entry.patch", {
        operation: { kind: "fields", patch: { label: "allowed" } },
        guards: { sources: [source] },
      });
    expect((await guardedPatch()).kind).toBe("committed");
    const sent = vi.fn();
    const send = () =>
      withConversationAuthority(
        scope,
        { conversationRef: conversation.conversationRef },
        (facts) => {
          assertConversationAuthority(facts.conversation, expected);
          return () => sent();
        },
      );
    await send();
    expect(sent).toHaveBeenCalledOnce();
    await patch(actor, { delivery: entry("channel:new").delivery });
    expect(await guardedPatch()).toMatchObject({
      kind: "rolled-back",
      error: { message: "Session source changed before entry mutation" },
    });
    const changedAddress = buildConversationIdentity({
      channel: conversation.channel,
      accountId: conversation.accountId,
      kind: conversation.kind,
      peerId: conversation.peerId,
      deliveryTarget: "channel:retargeted",
    })!;
    await registerConversationAddresses(scope, [changedAddress], 20);
    expect(
      await mutate(actor, "session.entry.patch", {
        operation: { kind: "fields", patch: { label: "stale" } },
        guards: { conversation: expected },
      }),
    ).toMatchObject({ kind: "rolled-back", error: { name: "ConversationAuthorityError" } });
    await expect(send()).rejects.toThrow("Conversation is no longer available");
    expect(sent).toHaveBeenCalledOnce();
  });

  it("selects eligible addresses once at registration and never exposes mutable owner records", async () => {
    const { actor } = await fixture();
    const eligible = address("yes");
    const excluded = address("no");
    const select = vi.fn(() => [true, false]);
    const registered = await registerConversationAddresses(
      scope,
      [eligible, excluded],
      100,
      select,
      { channel: "reef" },
    );
    expect(select).toHaveBeenCalledOnce();
    expect(registered).toHaveLength(1);
    registered![0]!.target = "changed-by-reader";
    expect(await read(eligible.conversationRef)).toHaveProperty("target", "reef:yes");
    expect(await read(excluded.conversationRef)).toBeUndefined();
    await expect(read(" ")).rejects.toThrow("Invalid conversationRef");
    const pending = registerConversationAddresses(scope, [excluded], 200, () => {
      throw new Error("transport closed");
    });
    await expect(pending).rejects.toThrow("transport closed");
    expect(await read(excluded.conversationRef)).toBeUndefined();
    expect((await actor.read(authority)).entry?.sessionId).toBe("first");
    await commit(actor, "session.lifecycle.delete", {});
    expect(await read(eligible.conversationRef)).toHaveProperty("target", "reef:yes");
    expect(resolveCurrentConversationSession(scope, eligible.conversationRef)).toBeUndefined();
    memorySessionActorOwners.closeDatabase(ownerTarget);
    expect(await listConversations(scope)).toEqual([]);
  });
});

describe("memory conversation delivery", () => {
  const key = "agent:main:dashboard:incognito-conversation";
  const sessionId = "conversation-1";
  const sendInput = {
    operationKind: "send" as const,
    conversationRef,
    sourceSessionKey: key,
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

  const deliveryFixture = () =>
    createMemoryConversation(key, {
      entry: conversationEntry(sessionId, 1),
      cwd: "/synthetic",
    });

  it("reports a bound publication failure while retaining the delivery receipt", async () => {
    const { binding } = await deliveryFixture();
    const input = { ...sendInput, operationId: "send", preparedMessageId: "prepared" };
    const stop = failSessionActorMemoryPublication(key);
    try {
      await expect(
        runWithSessionActorStorage(binding, () => delivery.begin(input)),
      ).rejects.toMatchObject({ name: "SessionActorStorageCommittedError" });
    } finally {
      stop();
    }
    const receipt = await delivery.get(input.operationId);
    expect(receipt).toMatchObject({ status: "created", preparedMessageId: "prepared" });
    expect(await delivery.begin(input)).toMatchObject({ created: false });
  });

  it("shares one receipt across retries and rejects reused input without changing it", async () => {
    await deliveryFixture();
    const input = { ...sendInput, operationId: "send-1" };
    expect(await delivery.get("send-1")).toBeUndefined();
    const [first, retry] = await Promise.all([
      delivery.begin(input),
      delivery.begin({ ...input, operationId: " send-1 " }),
    ]);
    expect(first).toMatchObject({ created: true, record: { status: "created", channel: "reef" } });
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
    const { actor } = await deliveryFixture();
    await delivery.begin({ ...turnInput, operationId: "turn-1", preparedMessageId: "prepared-1" });
    const queued = await delivery.queue("turn-1", "queue-1");
    expect(await delivery.find("prepared-1")).toEqual(queued);
    const sent = await delivery.send("turn-1", "platform-1");
    expect(await delivery.get("turn-1")).toEqual(sent);
    const replied = await delivery.reply({
      operationId: "turn-1",
      session: { sessionKey: key, sessionId },
      reply: { messageId: "reply-1", replyToId: "platform-1", text: "answer", timestamp: 100 },
    });
    expect(replied).toMatchObject({ status: "replied", reply: { text: "answer" } });
    expect(await delivery.send("turn-1", "late-platform")).toEqual(replied);
    expect(await delivery.find("platform-1")).toEqual(replied);
    expect(queued.status).toBe("queued");
    await commitMemory(actor.storage, "session.lifecycle.delete", {}, authority);
    expect(await delivery.get("turn-1")).toEqual(replied);
    memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: scope.storePath });
    expect(await delivery.get("turn-1")).toBeUndefined();
  });

  it("refuses captured replies to a replaced conversation and retains effect-time authority", async () => {
    const { actor, entry: currentEntry } = await deliveryFixture();
    await delivery.begin({ ...turnInput, operationId: "turn-reset" });
    await delivery.queue("turn-reset", "queue-reset");
    const nextEntry = {
      ...currentEntry,
      sessionId: "conversation-2",
      lifecycleRevision: "reset-2",
    };
    await commitMemory(
      actor.storage!,
      "session.lifecycle.reset",
      { expected: currentEntry, nextEntry },
      authority,
    );
    const params = {
      operationId: "turn-reset",
      reply: { messageId: "reply-reset", text: "answer", timestamp: 200 },
    };
    await expect(
      delivery.reply({ ...params, session: { sessionKey: key, sessionId } }),
    ).rejects.toThrow("session changed before captured reply persistence");
    await expect(
      delivery.reply(params, () => {
        throw new Error("transport authority revoked");
      }),
    ).rejects.toThrow("transport authority revoked");
    expect(await delivery.get("turn-reset")).toMatchObject({ status: "queued" });
    expect(
      await delivery.reply({
        ...params,
        session: { sessionKey: key, sessionId: "conversation-2", lifecycleRevision: "reset-2" },
      }),
    ).toMatchObject({ status: "replied", reply: { messageId: "reply-reset" } });
  });
});
