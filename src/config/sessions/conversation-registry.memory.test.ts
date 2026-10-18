import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { assertConversationAuthority } from "./conversation-authority.js";
import { buildConversationIdentity } from "./conversation-identity.js";
import {
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
import { acquireSessionActorStorage } from "./session-actor-storage-binding.js";
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
async function fixture() {
  const acquire = async () =>
    (await acquireSessionActorStorage(
      { ...scope, sessionKey },
      { authority, lifetime, create: true },
    ))!.actor;
  const actor = await acquire();
  const created = await commit(actor, "session.entry.create", {
    entry: entry("channel:ops"),
    routeContext: { peerId: "canonical-ops", guildId: "guild-a" },
  });
  return {
    owner: readOwner(),
    actor,
    created,
    acquire,
  };
}

describe("memory conversation registry", () => {
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
    await commit(actor, "session.entry.patch", {
      operation: { kind: "fields", patch: { totalTokens: 42, updatedAt: 3 } },
    });
    expect(await read(initial!.conversationRef)).toEqual(resumed);
    expect(await primary(created.sessionId)).toEqual(resumed);
    const updated = await commit(actor, "session.entry.patch", {
      operation: { kind: "fields", patch: { label: "renamed", updatedAt: 2 } },
    });
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
    const patch = () =>
      mutate(actor, "session.entry.patch", {
        operation: { kind: "fields", patch: { label: "allowed" } },
        guards: { sources: [source] },
      });
    expect((await patch()).kind).toBe("committed");
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
    await commit(actor, "session.entry.patch", {
      operation: { kind: "fields", patch: { delivery: entry("channel:new").delivery } },
    });
    expect(await patch()).toMatchObject({
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
