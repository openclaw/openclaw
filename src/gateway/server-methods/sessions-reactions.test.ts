import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { buildConversationIdentity } from "../../config/sessions/conversation-identity.js";
import { registerConversationAddresses } from "../../config/sessions/conversation-registry.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import * as reactionStore from "../../config/sessions/session-reaction-store.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.native.js";
import { publishSystemEventStoreConfig } from "../../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { MessageActionInput } from "../../infra/outbound/message-action-contracts.js";
import { publishSystemEventStoreResolver } from "../../infra/system-event-ownership.js";
import {
  drainSystemEventEntries,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  appendMessage,
  call,
  client,
  context,
  roleConfig,
  seedSession,
  sessionId,
  sessionKey,
  transcriptScope,
  withReactionState,
} from "./sessions-reactions.test-support.js";

const runMessageAction = vi.hoisted(() => vi.fn());
vi.mock("../../infra/outbound/message-action-runner.js", () => ({ runMessageAction }));

function registerReactionChannel(supportsReactions = true, reactionSlots?: "single" | "multiple") {
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: "testchat",
      capabilities: { chatTypes: ["direct"], reactionSlots },
    }),
    actions: {
      describeMessageTool: () => ({ actions: supportsReactions ? ["react"] : ["read"] }),
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "testchat", source: "test", plugin }]));
}

async function seedChannelMessage() {
  await seedSession();
  const identity = buildConversationIdentity({
    channel: "testchat",
    accountId: "work",
    kind: "channel",
    peerId: "room-42",
    deliveryTarget: "channel:room-42",
    nativeChannelId: "room-42",
    threadId: "thread-7",
  });
  if (!identity) {
    throw new Error("reaction fixture conversation identity missing");
  }
  await registerConversationAddresses({ agentId: "main" }, [identity]);
  const messageId = await appendMessage({
    role: "user",
    content: [{ type: "text", text: "Channel prompt" }],
    __openclaw: {
      senderName: "Riley",
      transport: {
        channel: "testchat",
        conversationRef: identity.conversationRef,
        messageId: "channel-message-9",
      },
    },
  });
  return {
    conversationRef: identity.conversationRef,
    messageId,
    config: { channels: { testchat: { enabled: true } } } as OpenClawConfig,
  };
}

beforeEach(() => {
  runMessageAction.mockReset().mockImplementation(async (input: MessageActionInput) => {
    await input.onPlatformSendDispatch?.();
    input.assertDirectAdapterHandoff?.();
    return {
      kind: "action",
      channel: "testchat",
      action: "react",
      handledBy: "plugin",
      payload: { ok: true },
      dryRun: false,
    };
  });
});

afterEach(() => {
  resetSystemEventsForTest();
  setActivePluginRegistry(createTestRegistry());
  vi.restoreAllMocks();
});

describe("session reaction handlers", () => {
  it("enforces session participation and operator caps before committing reactions", async () => {
    await withReactionState(async () => {
      const cases = [
        { name: "draft owner", identity: "owner", visibility: "draft", allowed: true },
        { name: "draft admin", identity: "admin", admin: true, visibility: "draft", allowed: true },
        {
          name: "draft member",
          identity: "member",
          member: true,
          visibility: "draft",
          allowed: false,
        },
        {
          name: "read-only member",
          identity: "member",
          member: true,
          visibility: "read-only",
          allowed: true,
        },
        { name: "shared viewer", identity: "viewer", visibility: "shared", allowed: true },
        {
          name: "write-capped shared viewer",
          identity: "viewer",
          cap: "write",
          visibility: "shared",
          allowed: true,
        },
        {
          name: "suggest-capped suggest viewer",
          identity: "viewer",
          cap: "suggest",
          visibility: "suggest",
          allowed: true,
        },
        {
          name: "view-capped suggest viewer",
          identity: "viewer",
          cap: "view",
          visibility: "suggest",
          allowed: false,
          viewDenied: true,
        },
        {
          name: "view-capped owner",
          identity: "owner",
          cap: "view",
          visibility: "shared",
          allowed: true,
        },
        {
          name: "none-capped viewer",
          identity: "viewer",
          cap: "none",
          visibility: "shared",
          allowed: false,
        },
        {
          name: "none-capped owner",
          identity: "owner",
          cap: "none",
          visibility: "shared",
          allowed: false,
        },
        {
          name: "suggest-capped shared viewer",
          identity: "viewer",
          cap: "suggest",
          visibility: "shared",
          allowed: false,
        },
        { name: "read-only viewer", identity: "viewer", visibility: "read-only", allowed: false },
      ] as const;
      for (const [index, scenario] of cases.entries()) {
        const key = `agent:main:reaction-access-${index}`;
        const scope = await seedSession(
          { visibility: scenario.visibility, sessionId: `access-${index}` },
          key,
        );
        if ("member" in scenario) {
          addSessionMember(scope, {
            identityId: "member",
            addedBy: "owner",
            expectedSessionId: scope.sessionId,
          });
        }
        const messageId = await appendMessage(undefined, scope);
        const requestContext = context("cap" in scenario ? roleConfig(scenario.cap) : {});
        const result = await call(
          "session.reactions.set",
          { sessionKey: key, messageId, emoji: "👍" },
          client(scenario.identity, scenario.identity, "admin" in scenario),
          requestContext,
        );
        expect(result[0], scenario.name).toBe(scenario.allowed);
        if ("viewDenied" in scenario) {
          expect(result[2]).toMatchObject({
            code: "FORBIDDEN",
            message: "your operator role permits viewing sessions only",
          });
        }
        if (!scenario.allowed) {
          expect(requestContext.broadcast, scenario.name).not.toHaveBeenCalled();
          expect(peekSystemEventEntries(key), scenario.name).toEqual([]);
        }
      }
    });
  });

  it("lets read-only viewers list everyone's reactions while hiding none-capped and incognito sessions", async () => {
    await withReactionState(async () => {
      await seedSession({ visibility: "read-only" });
      const messageId = await appendMessage();
      await call(
        "session.reactions.set",
        { sessionKey, messageId, emoji: "👍" },
        client("owner", "Owner"),
      );
      const listed = await call(
        "session.reactions.list",
        { sessionKey },
        client("viewer"),
        context(roleConfig("view")),
      );
      expect(listed).toMatchObject([
        true,
        {
          sessionId,
          reactions: {
            [messageId]: [{ emoji: "👍", count: 1, identities: [{ id: "owner", label: "Owner" }] }],
          },
        },
      ]);
      const hidden = await call(
        "session.reactions.list",
        { sessionKey },
        client("viewer"),
        context(roleConfig("none")),
      );
      expect(hidden[0]).toBe(false);
      expect(hidden[2]).toMatchObject({
        code: "INVALID_REQUEST",
        message: `unknown session: ${sessionKey}`,
      });

      const incognitoKey = "agent:main:dashboard:incognito-reactions";
      const incognitoScope = await seedSession(
        { incognito: true, sessionId: "incognito-reactions" },
        incognitoKey,
      );
      const incognitoMessageId = await appendMessage(undefined, incognitoScope);
      for (const method of ["session.reactions.set", "session.reactions.list"] as const) {
        const result = await call(
          method,
          {
            sessionKey: incognitoKey,
            ...(method.endsWith("set") ? { messageId: incognitoMessageId, emoji: "👍" } : {}),
          },
          client("owner"),
        );
        expect(result[0]).toBe(false);
        expect(result[2]).toMatchObject({
          message: `Incognito session "${incognitoKey}" was not found.`,
        });
      }
      const admin = client("admin", "Admin", true);
      expect(
        (
          await call(
            "session.reactions.set",
            { sessionKey: incognitoKey, messageId: incognitoMessageId, emoji: "👍" },
            admin,
          )
        )[0],
      ).toBe(true);
      expect(
        (await call("session.reactions.list", { sessionKey: incognitoKey }, admin))[1],
      ).toMatchObject({
        sessionId: "incognito-reactions",
        reactions: { [incognitoMessageId]: [{ count: 1 }] },
      });
    });
  });

  it("requires an identified author and one emoji grapheme", async () => {
    await withReactionState(async () => {
      await seedSession();
      const messageId = await appendMessage();
      const unidentified = await call(
        "session.reactions.set",
        { sessionKey, messageId, emoji: "👍" },
        null,
      );
      expect(unidentified[2]).toMatchObject({
        code: "INVALID_REQUEST",
        message: "identified reaction author required",
      });
      for (const emoji of [
        "",
        "hello",
        "👍👍",
        "a👍",
        "👍 ",
        "🇺",
        "1",
        "\u200d",
        `🏴${"\u{e0067}".repeat(31)}\u{e007f}`,
      ]) {
        const requestContext = context();
        const result = await call(
          "session.reactions.set",
          { sessionKey, messageId, emoji },
          client("alice"),
          requestContext,
        );
        expect(result[0], JSON.stringify(emoji)).toBe(false);
        expect(result[2]).toMatchObject({ code: "INVALID_REQUEST" });
        expect(requestContext.broadcast).not.toHaveBeenCalled();
      }
      for (const emoji of ["👍", "❤️", "👩🏽‍💻", "1️⃣", "🇦🇹"]) {
        expect(
          (await call("session.reactions.set", { sessionKey, messageId, emoji }))[0],
          emoji,
        ).toBe(true);
      }
    });
  });

  it("rejects missing, tool, and previous-session message ids", async () => {
    await withReactionState(async () => {
      await seedSession();
      const toolId = await appendMessage({
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "tool result" }],
        isError: false,
        timestamp: 1,
      });
      const oldMessageId = await appendMessage(undefined, {
        ...transcriptScope,
        sessionId: "previous-session",
      });
      const requestContext = context();
      for (const messageId of ["unknown", toolId, oldMessageId]) {
        const result = await call(
          "session.reactions.set",
          { sessionKey, messageId, emoji: "👍" },
          client("alice"),
          requestContext,
        );
        expect(result[2]).toMatchObject({ code: "INVALID_REQUEST", message: "unknown message" });
      }
      expect(requestContext.broadcast).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    });
  });

  it("broadcasts committed summaries and queues next-turn system events without changing transcript bytes", async () => {
    await withReactionState(async () => {
      await seedSession();
      const messageId = await appendMessage();
      const transcript = loadTranscriptEventsSync(transcriptScope);
      const requestContext = context();
      // The running Gateway publishes a physical-path resolver; the freshness
      // guard must accept queued reactions even when the state dir is symlinked
      // (macOS temp roots), which a resolver-less queue never exercises.
      publishSystemEventStoreConfig({});
      onTestFinished(() => publishSystemEventStoreResolver(undefined));
      for (const remove of [false, true, false]) {
        const action = remove ? "removed" : "added";
        const reactions = remove
          ? []
          : [{ emoji: "👍", count: 1, identities: [{ id: "alice", label: "Alice" }] }];
        const response = await call(
          "session.reactions.set",
          { sessionKey: "main", messageId, emoji: "👍", remove },
          client("alice", "Alice"),
          requestContext,
        );
        expect(response).toMatchObject([
          true,
          { messageId, reactions, mirror: { status: "skipped", reason: expect.any(String) } },
        ]);
        expect(requestContext.broadcast).toHaveBeenLastCalledWith(
          "session.reaction",
          {
            sessionKey,
            agentId: "main",
            sessionId,
            messageId,
            emoji: "👍",
            action,
            actor: { type: "human", id: "alice", label: "Alice" },
            reactions,
          },
          { sessionKeys: [sessionKey, "main"], agentId: "main" },
        );
        expect((await call("session.reactions.list", { sessionKey }))[1]).toEqual({
          sessionId,
          reactions: remove ? {} : { [messageId]: reactions },
        });
      }
      const events = drainSystemEventEntries(sessionKey);
      expect(events.map(({ text }) => text)).toEqual(
        ["added", "removed", "added"].map(
          (action) => `Control UI reaction ${action}: 👍 by Alice on msg ${messageId} from Riley`,
        ),
      );
      expect(new Set(events.map(({ contextKey }) => contextKey)).size).toBe(3);
      // Repeating the last addition changes nothing, so nothing is announced.
      const broadcasts = vi.mocked(requestContext.broadcast).mock.calls.length;
      expect(
        await call(
          "session.reactions.set",
          { sessionKey: "main", messageId, emoji: "👍" },
          client("alice", "Alice"),
          requestContext,
        ),
      ).toMatchObject([
        true,
        {
          reactions: [{ emoji: "👍", count: 1 }],
          mirror: { status: "skipped", reason: "reaction already in that state" },
        },
      ]);
      expect(requestContext.broadcast).toHaveBeenCalledTimes(broadcasts);
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      expect(runMessageAction).not.toHaveBeenCalled();
      expect(loadTranscriptEventsSync(transcriptScope)).toEqual(transcript);
    });
  });

  it("reports own prompts and assistant replies with author label fallbacks", async () => {
    await withReactionState(async () => {
      await seedSession();
      for (const [message, author] of [
        [
          {
            role: "user",
            content: "own prompt",
            __openclaw: { senderName: "Alice", senderId: "alice" },
          },
          "Alice",
        ],
        [
          {
            role: "user",
            content: "username prompt",
            __openclaw: { senderUsername: "riley", senderId: "peer-id" },
          },
          "riley",
        ],
        [{ role: "user", content: "id prompt", __openclaw: { senderId: "peer-id" } }, "peer-id"],
        [{ role: "assistant", content: "assistant reply" }, "assistant"],
      ] as const) {
        const messageId = await appendMessage(message);
        expect(
          (await call("session.reactions.set", { sessionKey, messageId, emoji: "🎉" }))[0],
        ).toBe(true);
        expect(drainSystemEventEntries(sessionKey)).toMatchObject([
          { text: `Control UI reaction added: 🎉 by Alice on msg ${messageId} from ${author}` },
        ]);
      }
    });
  });

  it("mirrors channel reactions after commit and broadcast, preserving the channel address on add and remove", async () => {
    await withReactionState(async () => {
      registerReactionChannel();
      const { messageId, config } = await seedChannelMessage();
      const requestContext = context(config);
      for (const remove of [false, true]) {
        runMessageAction.mockImplementationOnce(async () => {
          expect(requestContext.broadcast).toHaveBeenLastCalledWith(
            "session.reaction",
            expect.objectContaining({ action: remove ? "removed" : "added" }),
            expect.anything(),
          );
          expect(
            (
              await call("session.reactions.list", { sessionKey }, client("alice"), requestContext)
            )[1],
          ).toMatchObject({
            sessionId,
            reactions: remove ? {} : { [messageId]: [{ emoji: "👍", count: 1 }] },
          });
          return { kind: "action", payload: { ok: true } };
        });
        expect(
          (
            await call(
              "session.reactions.set",
              { sessionKey, messageId, emoji: "👍", remove },
              client("alice"),
              requestContext,
            )
          )[1],
        ).toMatchObject({ mirror: { status: "delivered" } });
        expect(runMessageAction).toHaveBeenLastCalledWith(
          expect.objectContaining({
            action: "react",
            agentId: "main",
            // The dispatch guard rejects delegated same-conversation reacts outside a turn.
            conversationReadOrigin: "direct-operator",
            params: expect.objectContaining({
              channel: "testchat",
              to: "channel:room-42",
              accountId: "work",
              threadId: "thread-7",
              messageId: "channel-message-9",
              emoji: "👍",
              remove,
            }),
          }),
        );
      }
    });
  });

  it.each(["single", "multiple", undefined] as const)(
    "preserves remaining reactions for channel reaction slots: %s",
    async (reactionSlots) => {
      await withReactionState(async () => {
        registerReactionChannel(true, reactionSlots);
        const { messageId, config } = await seedChannelMessage();
        const requestContext = context(config);
        const set = (emoji: string, remove = false) =>
          call(
            "session.reactions.set",
            { sessionKey, messageId, emoji, remove },
            client("alice"),
            requestContext,
          );
        for (const emoji of ["🎉", "👍", "🚀"]) {
          expect((await set(emoji))[1]).toMatchObject({ mirror: { status: "delivered" } });
          expect(runMessageAction).toHaveBeenLastCalledWith(
            expect.objectContaining({ params: expect.objectContaining({ emoji, remove: false }) }),
          );
        }
        for (const [emoji, remaining, replacement] of [
          ["🎉", ["👍", "🚀"], "🚀"],
          ["🚀", ["👍"], "👍"],
          ["👍", [], undefined],
        ] as const) {
          expect((await set(emoji, true))[1]).toMatchObject({
            reactions: remaining.map((value) => ({ emoji: value, count: 1 })),
            mirror: { status: "delivered" },
          });
          expect(runMessageAction).toHaveBeenLastCalledWith(
            expect.objectContaining({
              params: expect.objectContaining({
                emoji: reactionSlots === "single" ? (replacement ?? emoji) : emoji,
                remove: reactionSlots !== "single" || replacement === undefined,
              }),
            }),
          );
        }
      });
    },
  );

  it("uses the kernel's newest surviving emoji for a single-slot replacement", async () => {
    await withReactionState(async () => {
      registerReactionChannel(true, "single");
      const { messageId, config } = await seedChannelMessage();
      runOpenClawAgentWriteTransaction(
        (database) => {
          executeSqliteQuerySync(
            database.db,
            getNodeSqliteKysely<Pick<DB, "session_reactions">>(database.db)
              .insertInto("session_reactions")
              .values(
                [
                  { emoji: "👍", identity_id: "alice", created_at: 100 },
                  { emoji: "🎉", identity_id: "alice", created_at: 200 },
                  { emoji: "👍", identity_id: "bob", created_at: 300 },
                  { emoji: "🚀", identity_id: "alice", created_at: 400 },
                ].map(({ emoji, identity_id, created_at }) => ({
                  emoji,
                  identity_id,
                  created_at,
                  session_key: sessionKey,
                  session_id: sessionId,
                  message_id: messageId,
                  identity_label: null,
                })),
              ),
          );
        },
        { agentId: "main" },
      );
      const write = vi.spyOn(reactionStore, "setSessionReactionAsync");
      const response = await call(
        "session.reactions.set",
        { sessionKey, messageId, emoji: "🚀", remove: true },
        client("alice"),
        context(config),
      );
      expect(response).toMatchObject([
        true,
        {
          reactions: [
            { emoji: "👍", count: 2 },
            { emoji: "🎉", count: 1 },
          ],
          mirror: { status: "delivered" },
        },
      ]);
      expect(runMessageAction).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          params: expect.objectContaining({ emoji: "👍", remove: false }),
        }),
      );
      expect(await write.mock.results[0]?.value).toMatchObject({ newestRemainingEmoji: "👍" });
      expect(response[1]).not.toHaveProperty("newestRemainingEmoji");
    });
  });

  it("serializes different emoji in a single channel slot without blocking other messages", async () => {
    await withReactionState(async () => {
      registerReactionChannel(true, "single");
      const { messageId, config, conversationRef } = await seedChannelMessage();
      const otherMessageId = await appendMessage({
        role: "user",
        content: "Other channel prompt",
        __openclaw: {
          transport: { channel: "testchat", conversationRef, messageId: "channel-message-10" },
        },
      });
      const requestContext = context(config);
      const firstEntered = createDeferredCore();
      const releaseFirst = createDeferredCore();
      const secondCommitted = createDeferredCore();
      const delivered: unknown[] = [];
      vi.mocked(requestContext.broadcast).mockImplementation((_event, payload) => {
        if ((payload as { emoji: string }).emoji === "👍") {
          secondCommitted.resolve();
        }
      });
      runMessageAction.mockImplementation(async (input: MessageActionInput) => {
        await input.onPlatformSendDispatch?.();
        input.assertDirectAdapterHandoff?.();
        if (input.params.emoji === "🎉") {
          firstEntered.resolve();
          await releaseFirst.promise;
        }
        delivered.push(input.params.emoji);
        return { kind: "action", payload: { ok: true } };
      });
      const set = (id: string, emoji: string) =>
        call(
          "session.reactions.set",
          { sessionKey, messageId: id, emoji },
          client("alice"),
          requestContext,
        );
      const first = set(messageId, "🎉");
      await firstEntered.promise;
      const second = set(messageId, "👍");
      try {
        await secondCommitted.promise;
        expect((await set(otherMessageId, "🚀"))[1]).toMatchObject({
          mirror: { status: "delivered" },
        });
        expect(delivered).toEqual(["🚀"]);
      } finally {
        releaseFirst.resolve();
        await Promise.all([first, second]);
      }
      expect(delivered).toEqual(["🚀", "🎉", "👍"]);
    });
  });

  it("refuses a view-capped channel reactor before commit, broadcast, or dispatch", async () => {
    await withReactionState(async () => {
      registerReactionChannel();
      const { messageId, config } = await seedChannelMessage();
      const requestContext = context({ ...config, ...roleConfig("view") });
      const result = await call(
        "session.reactions.set",
        { sessionKey, messageId, emoji: "👍" },
        client("alice"),
        requestContext,
      );
      expect(result).toMatchObject([false, undefined, { code: "FORBIDDEN" }]);
      expect((await call("session.reactions.list", { sessionKey }))[1]).toEqual({
        sessionId,
        reactions: {},
      });
      expect(requestContext.broadcast).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      expect(runMessageAction).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])(
    "rechecks reactor authority at channel I/O after commit (revoked: %s)",
    async (revoked) => {
      await withReactionState(async () => {
        registerReactionChannel();
        const { messageId, config } = await seedChannelMessage();
        const requestContext = context(config);
        const reactor = client("alice");
        const handoffEntered = createDeferredCore();
        const releaseHandoff = createDeferredCore();
        const channelRequest = vi.fn();
        runMessageAction.mockImplementationOnce(async (input: MessageActionInput) => {
          handoffEntered.resolve();
          await releaseHandoff.promise;
          input.assertDirectAdapterHandoff?.();
          channelRequest(input.params);
          return { kind: "action", payload: { ok: true } };
        });
        const pending = call(
          "session.reactions.set",
          { sessionKey, messageId, emoji: "👍" },
          reactor,
          requestContext,
        );
        await handoffEntered.promise;
        try {
          expect(requestContext.broadcast).toHaveBeenCalledTimes(1);
          expect((await call("session.reactions.list", { sessionKey }))[1]).toMatchObject({
            reactions: { [messageId]: [{ emoji: "👍", count: 1 }] },
          });
          expect(channelRequest).not.toHaveBeenCalled();
          if (revoked) {
            reactor.invalidated = true;
          }
        } finally {
          releaseHandoff.resolve();
        }
        const result = await pending;
        expect(result).toMatchObject([
          true,
          {
            reactions: [{ emoji: "👍", count: 1 }],
            mirror: revoked
              ? { status: "failed", reason: "reaction author or session authority changed" }
              : { status: "delivered" },
          },
        ]);
        expect(channelRequest).toHaveBeenCalledTimes(revoked ? 0 : 1);
        expect(runMessageAction).toHaveBeenCalledTimes(1);
      });
    },
  );

  it("rechecks the source conversation after awaited action preparation", async () => {
    await withReactionState(async () => {
      registerReactionChannel();
      for (const change of [
        "removed",
        "channel",
        "account",
        "target",
        "thread",
        "nativeChannel",
      ] as const) {
        runMessageAction.mockClear();
        const { messageId, config, conversationRef } = await seedChannelMessage();
        const channelRequest = vi.fn();
        runMessageAction.mockImplementationOnce(async (input: MessageActionInput) => {
          await Promise.resolve();
          runOpenClawAgentWriteTransaction(
            (database) => {
              const db = getNodeSqliteKysely<Pick<DB, "conversations">>(database.db);
              if (change === "removed") {
                executeSqliteQuerySync(
                  database.db,
                  db.deleteFrom("conversations").where("conversation_id", "=", conversationRef),
                );
              } else {
                const next = {
                  channel: { channel: "otherchat" },
                  account: { account_id: "other-account" },
                  target: { delivery_target: "channel:other-room" },
                  thread: { thread_id: "other-thread" },
                  nativeChannel: { native_channel_id: "other-native-room" },
                }[change];
                executeSqliteQuerySync(
                  database.db,
                  db
                    .updateTable("conversations")
                    .set(next)
                    .where("conversation_id", "=", conversationRef),
                );
              }
            },
            { agentId: "main" },
          );
          await input.onPlatformSendDispatch?.();
          input.assertDirectAdapterHandoff?.();
          channelRequest(input.params);
          return { kind: "action", payload: { ok: true } };
        });
        expect(
          await call(
            "session.reactions.set",
            { sessionKey, messageId, emoji: "👍" },
            client("alice"),
            context(config),
          ),
        ).toMatchObject([
          true,
          {
            reactions: [{ emoji: "👍", count: 1 }],
            mirror: {
              status: "failed",
              reason: "source conversation changed before delivery",
            },
          },
        ]);
        expect(runMessageAction).toHaveBeenCalledTimes(1);
        expect(channelRequest).not.toHaveBeenCalled();
      }
    });
  });

  it("keeps one bot reaction per emoji while any reactor remains, in commit order", async () => {
    await withReactionState(async () => {
      registerReactionChannel();
      const { messageId, config } = await seedChannelMessage();
      const requestContext = context(config);
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstEntered = createDeferredCore();
      runMessageAction
        .mockImplementationOnce(async () => {
          firstEntered.resolve();
          await firstHeld;
          return { kind: "action", payload: { ok: true } };
        })
        .mockResolvedValue({ kind: "action", payload: { ok: true } });
      const set = (profile: string, remove: boolean) =>
        call(
          "session.reactions.set",
          { sessionKey, messageId, emoji: "👍", remove },
          client(profile, profile),
          requestContext,
        );
      // Alice's add is still in flight at the channel when Bob joins and Alice leaves.
      const aliceAdd = set("alice", false);
      await firstEntered.promise;
      expect(runMessageAction).toHaveBeenCalledTimes(1);
      expect((await set("bob", false))[1]).toMatchObject({
        mirror: { status: "skipped", reason: expect.stringContaining("other reactors") },
      });
      expect((await set("alice", true))[1]).toMatchObject({
        mirror: { status: "skipped", reason: expect.stringContaining("other reactors") },
      });
      // Bob's removal empties the emoji, but must not overtake Alice's pending add.
      const bobRemove = set("bob", true);
      await Promise.resolve();
      expect(runMessageAction).toHaveBeenCalledTimes(1);
      releaseFirst();
      expect((await aliceAdd)[1]).toMatchObject({ mirror: { status: "delivered" } });
      expect((await bobRemove)[1]).toMatchObject({ mirror: { status: "delivered" } });
      expect(
        runMessageAction.mock.calls.map(
          ([input]) => (input as { params: { remove: boolean } }).params.remove,
        ),
      ).toEqual([false, true]);
    });
  });

  it("keeps local reactions successful when channel mirroring fails or cannot be supported", async () => {
    await withReactionState(async () => {
      registerReactionChannel();
      const { messageId, config } = await seedChannelMessage();
      const requestContext = context(config);
      runMessageAction.mockRejectedValueOnce(new Error("channel offline"));
      const failed = await call(
        "session.reactions.set",
        { sessionKey, messageId, emoji: "👍" },
        client("alice"),
        requestContext,
      );
      expect(failed).toMatchObject([
        true,
        {
          reactions: [{ emoji: "👍", count: 1 }],
          mirror: { status: "failed", reason: expect.stringContaining("channel offline") },
        },
      ]);
      expect(requestContext.logGateway.warn).toHaveBeenCalled();
      expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
      for (const skippedConfig of [{}, { channels: { testchat: { enabled: false } } }, config]) {
        if (skippedConfig === config) {
          registerReactionChannel(false);
        }
        const result = await call(
          "session.reactions.set",
          { sessionKey, messageId, emoji: "🎉" },
          client("alice"),
          context(skippedConfig),
        );
        expect(result).toMatchObject([
          true,
          { mirror: { status: "skipped", reason: expect.any(String) } },
        ]);
      }
      expect(runMessageAction).toHaveBeenCalledTimes(1);
    });
  });
});
