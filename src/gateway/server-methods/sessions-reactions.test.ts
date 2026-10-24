import type { Compilable, Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { buildConversationIdentity } from "../../config/sessions/conversation-identity.js";
import { registerConversationAddresses } from "../../config/sessions/conversation-registry.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
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
  setReaction,
  listReactions,
  client,
  context,
  roleConfig,
  reactionGate,
  seedSession,
  sessionId,
  sessionKey,
  transcriptScope,
  withReactionState,
} from "./sessions-reactions.test-support.js";

const runMessageAction = vi.hoisted(() => vi.fn());
vi.mock("../../infra/outbound/message-action-runner.js", () => ({ runMessageAction }));

function writeFixture(build: (db: Kysely<DB>) => Compilable) {
  return runOpenClawAgentWriteTransaction(
    (database) => executeSqliteQuerySync(database.db, build(getNodeSqliteKysely<DB>(database.db))),
    { agentId: "main" },
  );
}

function expectMirror(
  response: Awaited<ReturnType<typeof setReaction>>,
  mirror: unknown,
  reactions = [{ emoji: "👍", count: 1 }],
) {
  expect(response).toMatchObject([true, { reactions, mirror }]);
}

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
    return { kind: "action", payload: { ok: true } };
  });
});

afterEach(() => {
  resetSystemEventsForTest();
  setActivePluginRegistry(createTestRegistry());
  vi.restoreAllMocks();
});

it("enforces session participation and operator caps before committing reactions", () =>
  withReactionState(async () => {
    const cases = [
      ["owner", "draft", undefined, true],
      ["admin", "draft", undefined, true],
      ["member", "draft", undefined, false],
      ["member", "read-only", undefined, true],
      ["viewer", "shared", undefined, true],
      ["viewer", "shared", "write", true],
      ["viewer", "suggest", "suggest", true],
      ["viewer", "suggest", "view", false],
      ["owner", "shared", "view", true],
      ["viewer", "shared", "none", false],
      ["owner", "shared", "none", false],
      ["viewer", "shared", "suggest", false],
      ["viewer", "read-only", undefined, false],
    ] as const;
    for (const [index, [identity, visibility, cap, allowed]] of cases.entries()) {
      const name = `${cap ?? "uncapped"} ${visibility} ${identity}`;
      const key = `agent:main:reaction-access-${index}`;
      const scope = await seedSession({ visibility, sessionId: `access-${index}` }, key);
      if (identity === "member") {
        addSessionMember(scope, {
          identityId: "member",
          addedBy: "owner",
          expectedSessionId: scope.sessionId,
        });
      }
      const messageId = await appendMessage(undefined, scope);
      const requestContext = context(cap ? roleConfig(cap) : {});
      const result = await setReaction(
        messageId,
        { sessionKey: key },
        client(identity, identity, identity === "admin"),
        requestContext,
      );
      expect(result[0], name).toBe(allowed);
      if (cap === "view" && identity === "viewer") {
        expect(result[2]).toMatchObject({
          code: "FORBIDDEN",
          message: "your operator role permits viewing sessions only",
        });
      }
      if (!allowed) {
        expect(requestContext.broadcast, name).not.toHaveBeenCalled();
        expect(peekSystemEventEntries(key), name).toEqual([]);
      }
    }
  }));

it("lets read-only viewers list everyone's reactions while hiding none-capped and incognito sessions", () =>
  withReactionState(async () => {
    await seedSession({ visibility: "read-only" });
    const messageId = await appendMessage();
    await setReaction(messageId, {}, client("owner", "Owner"));
    const listed = await listReactions(client("viewer"), context(roleConfig("view")));
    expect(listed).toMatchObject([
      true,
      {
        sessionId,
        reactions: {
          [messageId]: [{ emoji: "👍", count: 1, identities: [{ id: "owner", label: "Owner" }] }],
        },
      },
    ]);
    expect(await listReactions(client("viewer"), context(roleConfig("none")))).toMatchObject([
      false,
      undefined,
      { code: "INVALID_REQUEST", message: `unknown session: ${sessionKey}` },
    ]);

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
    expect((await setReaction(incognitoMessageId, { sessionKey: incognitoKey }, admin))[0]).toBe(
      true,
    );
    expect((await listReactions(admin, undefined, incognitoKey))[1]).toMatchObject({
      sessionId: "incognito-reactions",
      reactions: { [incognitoMessageId]: [{ count: 1 }] },
    });
  }));

it("requires an identified author and one emoji grapheme", () =>
  withReactionState(async () => {
    await seedSession();
    const messageId = await appendMessage();
    const unidentified = await setReaction(messageId, {}, null);
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
      const result = await setReaction(messageId, { emoji }, client("alice"), requestContext);
      expect(result[0], JSON.stringify(emoji)).toBe(false);
      expect(result[2]).toMatchObject({ code: "INVALID_REQUEST" });
      expect(requestContext.broadcast).not.toHaveBeenCalled();
    }
    for (const emoji of ["👍", "❤️", "👩🏽‍💻", "1️⃣", "🇦🇹"]) {
      expect((await setReaction(messageId, { emoji }))[0], emoji).toBe(true);
    }
  }));

it("rejects missing, tool, and previous-session message ids", () =>
  withReactionState(async () => {
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
      const result = await setReaction(messageId, {}, client("alice"), requestContext);
      expect(result[2]).toMatchObject({ code: "INVALID_REQUEST", message: "unknown message" });
    }
    expect(requestContext.broadcast).not.toHaveBeenCalled();
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  }));

it("broadcasts committed summaries and queues next-turn system events without changing transcript bytes", () =>
  withReactionState(async () => {
    await seedSession();
    const messageId = await appendMessage();
    const transcript = loadTranscriptEventsSync(transcriptScope);
    const requestContext = context();
    const set = (params: Record<string, unknown> = {}) =>
      setReaction(
        messageId,
        { sessionKey: "main", ...params },
        client("alice", "Alice"),
        requestContext,
      );
    // Physical-path resolution must also work with symlinked macOS temp roots.
    publishSystemEventStoreConfig({});
    onTestFinished(() => publishSystemEventStoreResolver(undefined));
    for (const remove of [false, true, false]) {
      const action = remove ? "removed" : "added";
      const reactions = remove
        ? []
        : [{ emoji: "👍", count: 1, identities: [{ id: "alice", label: "Alice" }] }];
      const response = await set({ remove });
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
      expect((await listReactions())[1]).toEqual({
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
    expect(await set()).toMatchObject([
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
  }));

it("reports own prompts and assistant replies with author label fallbacks", () =>
  withReactionState(async () => {
    await seedSession();
    for (const [role, metadata, author] of [
      ["user", { senderUsername: "riley", senderId: "peer-id" }, "riley"],
      ["user", { senderId: "peer-id" }, "peer-id"],
      ["assistant", undefined, "assistant"],
    ] as const) {
      const messageId = await appendMessage({ role, content: "prompt", __openclaw: metadata });
      expect((await setReaction(messageId, { emoji: "🎉" }))[0]).toBe(true);
      expect(drainSystemEventEntries(sessionKey)).toMatchObject([
        { text: `Control UI reaction added: 🎉 by Alice on msg ${messageId} from ${author}` },
      ]);
    }
  }));

it("uses the kernel's newest surviving emoji for a single-slot replacement", () =>
  withReactionState(async () => {
    registerReactionChannel(true, "single");
    const { messageId, config } = await seedChannelMessage();
    writeFixture((db) =>
      db.insertInto("session_reactions").values(
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
    const response = await setReaction(
      messageId,
      { emoji: "🚀", remove: true },
      client("alice"),
      context(config),
    );
    expectMirror(response, { status: "delivered" }, [
      { emoji: "👍", count: 2 },
      { emoji: "🎉", count: 1 },
    ]);
    expect(runMessageAction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        params: expect.objectContaining({ emoji: "👍", remove: false }),
      }),
    );
    expect(response[1]).not.toHaveProperty("newestRemainingEmoji");
  }));

it("serializes different emoji in a single channel slot without blocking other messages", () =>
  withReactionState(async () => {
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
    const firstGate = reactionGate();
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
        await firstGate.wait();
      }
      delivered.push(input.params.emoji);
      return { kind: "action", payload: { ok: true } };
    });
    const set = (id: string, emoji: string) =>
      setReaction(id, { emoji }, client("alice"), requestContext);
    const first = set(messageId, "🎉");
    await firstGate.entered;
    const second = set(messageId, "👍");
    try {
      await secondCommitted.promise;
      expect((await set(otherMessageId, "🚀"))[1]).toMatchObject({
        mirror: { status: "delivered" },
      });
      expect(delivered).toEqual(["🚀"]);
    } finally {
      firstGate.release();
      await Promise.all([first, second]);
    }
    expect(delivered).toEqual(["🚀", "🎉", "👍"]);
  }));

it("rechecks revoked reactor authority at channel I/O after commit", () =>
  withReactionState(async () => {
    registerReactionChannel();
    const { messageId, config } = await seedChannelMessage();
    const requestContext = context(config);
    const reactor = client("alice");
    const handoff = reactionGate();
    const channelRequest = vi.fn();
    runMessageAction.mockImplementationOnce(async (input: MessageActionInput) => {
      await handoff.wait();
      input.assertDirectAdapterHandoff?.();
      channelRequest(input.params);
      return { kind: "action", payload: { ok: true } };
    });
    const pending = setReaction(messageId, {}, reactor, requestContext);
    await handoff.entered;
    try {
      expect(requestContext.broadcast).toHaveBeenCalledTimes(1);
      expect((await listReactions())[1]).toMatchObject({
        reactions: { [messageId]: [{ emoji: "👍", count: 1 }] },
      });
      expect(channelRequest).not.toHaveBeenCalled();
      reactor.invalidated = true;
    } finally {
      handoff.release();
    }
    const result = await pending;
    expectMirror(result, {
      status: "failed",
      reason: "reaction author or session authority changed",
    });
    expect(channelRequest).not.toHaveBeenCalled();
    expect(runMessageAction).toHaveBeenCalledTimes(1);
  }));

it("rechecks the source conversation after awaited action preparation", () =>
  withReactionState(async () => {
    registerReactionChannel();
    for (const patch of [
      null,
      { channel: "otherchat" },
      { account_id: "other-account" },
      { delivery_target: "channel:other-room" },
      { thread_id: "other-thread" },
      { native_channel_id: "other-native-room" },
    ] as const) {
      runMessageAction.mockClear();
      const { messageId, config, conversationRef } = await seedChannelMessage();
      const channelRequest = vi.fn();
      runMessageAction.mockImplementationOnce(async (input: MessageActionInput) => {
        await Promise.resolve();
        writeFixture((db) =>
          patch
            ? db
                .updateTable("conversations")
                .set(patch)
                .where("conversation_id", "=", conversationRef)
            : db.deleteFrom("conversations").where("conversation_id", "=", conversationRef),
        );
        await input.onPlatformSendDispatch?.();
        input.assertDirectAdapterHandoff?.();
        channelRequest(input.params);
        return { kind: "action", payload: { ok: true } };
      });
      expectMirror(await setReaction(messageId, {}, client("alice"), context(config)), {
        status: "failed",
        reason: "source conversation changed before delivery",
      });
      expect(runMessageAction).toHaveBeenCalledTimes(1);
      expect(channelRequest).not.toHaveBeenCalled();
    }
  }));

it("keeps one bot reaction per emoji while any reactor remains, in commit order", () =>
  withReactionState(async () => {
    registerReactionChannel();
    const { messageId, config } = await seedChannelMessage();
    const requestContext = context(config);
    const firstGate = reactionGate();
    runMessageAction
      .mockImplementationOnce(async () => {
        await firstGate.wait();
        return { kind: "action", payload: { ok: true } };
      })
      .mockResolvedValue({ kind: "action", payload: { ok: true } });
    const set = (profile: string, remove: boolean) =>
      setReaction(messageId, { remove }, client(profile, profile), requestContext);
    // Alice's add is still in flight at the channel when Bob joins and Alice leaves.
    const aliceAdd = set("alice", false);
    await firstGate.entered;
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
    firstGate.release();
    expect((await aliceAdd)[1]).toMatchObject({ mirror: { status: "delivered" } });
    expect((await bobRemove)[1]).toMatchObject({ mirror: { status: "delivered" } });
    expect(
      runMessageAction.mock.calls.map(
        ([input]) => (input as { params: { remove: boolean } }).params.remove,
      ),
    ).toEqual([false, true]);
  }));

it("keeps local reactions successful when channel mirroring fails or cannot be supported", () =>
  withReactionState(async () => {
    registerReactionChannel();
    const { messageId, config } = await seedChannelMessage();
    const requestContext = context(config);
    runMessageAction.mockRejectedValueOnce(new Error("channel offline"));
    const failed = await setReaction(messageId, {}, client("alice"), requestContext);
    expectMirror(failed, {
      status: "failed",
      reason: expect.stringContaining("channel offline"),
    });
    expect(requestContext.logGateway.warn).toHaveBeenCalled();
    expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
    for (const skippedConfig of [{}, { channels: { testchat: { enabled: false } } }, config]) {
      if (skippedConfig === config) {
        registerReactionChannel(false);
      }
      const result = await setReaction(
        messageId,
        { emoji: "🎉" },
        client("alice"),
        context(skippedConfig),
      );
      expect(result).toMatchObject([
        true,
        { mirror: { status: "skipped", reason: expect.any(String) } },
      ]);
    }
    expect(runMessageAction).toHaveBeenCalledTimes(1);
  }));
