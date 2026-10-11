import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

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
const scope = { agentId: "main", storePath: "/synthetic/memory-conversation-registry" };
const sessionKey = "agent:main:dashboard:incognito-conversation-registry";
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

function entry(target: string, updatedAt = 1): SessionEntry {
  return {
    sessionId: "first",
    updatedAt,
    chatType: "channel",
    delivery: {
      kind: "external",
      route: { channel: "discord", target: { to: target } },
      context: { channel: "discord", accountId: "default", to: target },
    },
  };
}
async function fixture() {
  const owner = createMemorySessionActorOwner({ agentId: scope.agentId, path: scope.storePath });
  owners.push(owner);
  const acquire = () => owner.acquire({ database: owner.identity, sessionKey }, lifetime);
  const actor = await acquire();
  const created = readSessionActorStorageResult(
    await actor.storage!.mutate(
      {
        type: "session.entry.create",
        input: {
          entry: entry("channel:ops"),
          routeContext: { peerId: "canonical-ops", guildId: "guild-a" },
        },
      },
      authority,
    ),
  );
  return {
    owner,
    actor,
    created,
    acquire,
    binding: { actor, authority, agentId: scope.agentId, path: scope.storePath },
  };
}

describe("memory conversation registry", () => {
  it("retains observed identity through generic writes and changes current bindings at rebind/reset", async () => {
    const { actor, acquire, created, binding } = await fixture();
    await runWithSessionActorStorage(binding, async () => {
      const initial = await resolveCurrentSessionPrimaryConversation({
        ...scope,
        sessionKey,
        sessionId: created.sessionId,
      });
      expect(initial).toMatchObject({
        peerId: "canonical-ops",
        routeContext: { guildId: "guild-a" },
        routeContextObserved: true,
      });
      const updated = readSessionActorStorageResult(
        await actor.storage!.mutate(
          {
            type: "session.entry.patch",
            input: { operation: { kind: "fields", patch: { label: "renamed", updatedAt: 2 } } },
          },
          authority,
        ),
      );
      expect(await readConversation(scope, initial!.conversationRef)).toMatchObject({
        conversationRef: initial!.conversationRef,
        peerId: "canonical-ops",
        label: "renamed",
        routeContext: { guildId: "guild-a" },
      });
      const rebound = readSessionActorStorageResult(
        await actor.storage!.mutate(
          {
            type: "session.entry.replace",
            input: { expected: updated, entry: entry("channel:other", 3) },
          },
          authority,
        ),
      );
      expect(resolveCurrentConversationSession(scope, initial!.conversationRef)).toBeUndefined();
      const current = await resolveCurrentSessionPrimaryConversation({
        ...scope,
        sessionKey,
        sessionId: "first",
      });
      expect(current).toMatchObject({ target: "channel:other", role: "primary" });
      expect(await readConversation(scope, initial!.conversationRef)).toMatchObject({
        role: "related",
      });
      readSessionActorStorageResult(
        await actor.storage!.mutate(
          {
            type: "session.lifecycle.reset",
            input: {
              expected: rebound,
              nextEntry: { ...rebound!, sessionId: "second", updatedAt: 4 },
            },
          },
          authority,
        ),
      );
      const replacement = await acquire();
      await runWithSessionActorStorage({ ...binding, actor: replacement }, async () => {
        expect(resolveCurrentConversationSession(scope, current!.conversationRef)).toEqual({
          sessionKey,
          sessionId: "second",
        });
        expect(
          await resolveCurrentSessionPrimaryConversation({
            ...scope,
            sessionKey,
            sessionId: "first",
          }),
        ).toBeUndefined();
      });
    });
  });

  it("uses stored associations for source predicates and the route fingerprint at external effects", async () => {
    const { actor, owner, binding } = await fixture();
    await runWithSessionActorStorage(binding, async () => {
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
        actor.storage!.mutate(
          {
            type: "session.entry.patch",
            input: {
              operation: { kind: "fields", patch: { label: "allowed" } },
              guards: { sources: [source] },
            },
          },
          authority,
        );
      expect((await patch()).kind).toBe("committed");
      const sent = vi.fn();
      await withConversationAuthority(
        scope,
        { conversationRef: conversation.conversationRef },
        (facts) => {
          assertConversationAuthority(facts.conversation, expected);
          return () => sent();
        },
      );
      expect(sent).toHaveBeenCalledOnce();
      readSessionActorStorageResult(
        await actor.storage!.mutate(
          {
            type: "session.entry.patch",
            input: {
              operation: { kind: "fields", patch: { delivery: entry("channel:new").delivery } },
            },
          },
          authority,
        ),
      );
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
        await actor.storage!.mutate(
          {
            type: "session.entry.patch",
            input: {
              operation: { kind: "fields", patch: { label: "stale" } },
              guards: { conversation: expected },
            },
          },
          authority,
        ),
      ).toMatchObject({ kind: "rolled-back", error: { name: "ConversationAuthorityError" } });
      await expect(
        withConversationAuthority(
          scope,
          { conversationRef: conversation.conversationRef },
          (facts) => {
            assertConversationAuthority(facts.conversation, expected);
            return () => sent();
          },
        ),
      ).rejects.toThrow("Conversation is no longer available");
      expect(sent).toHaveBeenCalledOnce();
    });
  });

  it("selects eligible addresses once at registration and never exposes mutable owner records", async () => {
    const { actor, binding } = await fixture();
    await runWithSessionActorStorage(binding, async () => {
      const eligible = buildConversationIdentity({
        channel: "reef",
        kind: "direct",
        peerId: "yes",
        deliveryTarget: "reef:yes",
      })!;
      const excluded = buildConversationIdentity({
        channel: "reef",
        kind: "direct",
        peerId: "no",
        deliveryTarget: "reef:no",
      })!;
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
      expect(await readConversation(scope, eligible.conversationRef)).toMatchObject({
        target: "reef:yes",
      });
      expect(await readConversation(scope, excluded.conversationRef)).toBeUndefined();
      await expect(readConversation(scope, " ")).rejects.toThrow("Invalid conversationRef");
      const pending = registerConversationAddresses(scope, [excluded], 200, () => {
        throw new Error("transport closed");
      });
      await expect(pending).rejects.toThrow("transport closed");
      expect(await readConversation(scope, excluded.conversationRef)).toBeUndefined();
      expect((await actor.read(authority)).entry?.sessionId).toBe("first");
    });
  });
});
