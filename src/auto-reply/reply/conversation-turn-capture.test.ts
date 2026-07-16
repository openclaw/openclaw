import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadTranscriptEvents,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildConversationRef } from "../../routing/conversation-ref.js";
import { registerPendingConversationTurn } from "../../sessions/conversation-turns.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import type { FinalizedMsgContext } from "../templating.js";
import { capturePendingConversationTurnReply } from "./conversation-turn-capture.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("conversation turn capture", () => {
  it("fails closed without channel ingress admission proof", async () => {
    const pending = registerPendingConversationTurn({
      conversationRef: "conv_0123456789abcdef0123456789abcdef",
      sessionId: "session-main",
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("outbound-untrusted");
    pending.markReady();

    await expect(
      capturePendingConversationTurnReply({
        cfg: {} as OpenClawConfig,
        ctx: {
          SessionKey: "agent:main:reef:direct:untrusted",
          ChatType: "direct",
          Provider: "reef",
          ReplyToIdFull: "outbound-untrusted",
          RawBody: "untrusted reply",
        } as FinalizedMsgContext,
      }),
    ).resolves.toBe(false);
    pending.cancel();
    await expect(pending.wait()).resolves.toBeUndefined();
  });

  it("consumes a full-id correlated reply through the shared dispatch boundary", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-conversation-capture-"));
    tempDirs.push(stateDir);
    const storePath = path.join(stateDir, "sessions.json");
    const sessionKey = "agent:main:reef:direct:peer-agent";
    const sessionId = "reef-session";
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId,
        updatedAt: 100,
        chatType: "direct",
        deliveryContext: {
          channel: "reef",
          accountId: "default",
          to: "reef:peer-agent",
        },
        origin: {
          provider: "reef",
          accountId: "default",
          nativeDirectUserId: "peer-agent",
        },
      },
    );
    const conversationRef = buildConversationRef({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "peer-agent",
    });
    const pending = registerPendingConversationTurn({
      conversationRef,
      sessionId,
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("reef-outbound-full");
    pending.markReady();

    const captured = await capturePendingConversationTurnReply({
      cfg,
      ctx: {
        AgentId: "main",
        SessionKey: sessionKey,
        ChatType: "direct",
        Provider: "reef",
        InboundAccessAuthorized: true,
        OriginatingChannel: "reef",
        OriginatingTo: "reef:peer-agent",
        NativeDirectUserId: "peer-agent",
        MessageSid: "reef-inbound-short",
        MessageSidFull: "reef-inbound-full",
        ReplyToId: "wrong-short-id",
        ReplyToIdFull: "reef-outbound-full",
        RawBody: "peer acknowledged",
        BodyForAgent: "trusted provenance\n\n<reef-message>peer acknowledged</reef-message>",
        Timestamp: 1_710_000_000,
      } as FinalizedMsgContext,
    });

    expect(captured).toBe(true);
    await expect(pending.wait()).resolves.toMatchObject({
      conversationRef,
      messageId: "reef-inbound-full",
      replyToId: "reef-outbound-full",
      text: "trusted provenance\n\n<reef-message>peer acknowledged</reef-message>",
      timestamp: 1_710_000_000_000,
      transcriptMessageId: expect.any(String),
    });
    const messages = (await loadTranscriptEvents({ agentId: "main", sessionId, storePath }))
      .map((event) => (event as { message?: Record<string, unknown> }).message)
      .filter((message): message is Record<string, unknown> => Boolean(message));
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: "peer acknowledged",
        __openclaw: {
          transport: expect.objectContaining({
            conversationRef,
            messageId: "reef-inbound-full",
            replyToId: "reef-outbound-full",
          }),
        },
      }),
    );
  });

  it("normalizes body candidates and short transport ids independently", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-conversation-capture-"));
    tempDirs.push(stateDir);
    const storePath = path.join(stateDir, "sessions.json");
    const sessionKey = "agent:main:reef:direct:peer-agent";
    const sessionId = "reef-session";
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId,
        updatedAt: 100,
        chatType: "direct",
        deliveryContext: {
          channel: "reef",
          accountId: "default",
          to: "reef:peer-agent",
        },
        origin: {
          provider: "reef",
          accountId: "default",
          nativeDirectUserId: "peer-agent",
        },
      },
    );
    const conversationRef = buildConversationRef({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "peer-agent",
    });
    const pending = registerPendingConversationTurn({
      conversationRef,
      sessionId,
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("reef-outbound-short");
    pending.markReady();

    const captured = await capturePendingConversationTurnReply({
      cfg,
      ctx: {
        AgentId: "main",
        SessionKey: sessionKey,
        ChatType: "direct",
        Provider: "reef",
        InboundAccessAuthorized: true,
        OriginatingChannel: "reef",
        OriginatingTo: "reef:peer-agent",
        NativeDirectUserId: "peer-agent",
        MessageSid: "reef-inbound-short",
        MessageSidFull: "   ",
        ReplyToId: "reef-outbound-short",
        ReplyToIdFull: "",
        RawBody: "   ",
        BodyForAgent: "short ids acknowledged",
      } as FinalizedMsgContext,
    });

    expect(captured).toBe(true);
    await expect(pending.wait()).resolves.toMatchObject({
      conversationRef,
      messageId: "reef-inbound-short",
      replyToId: "reef-outbound-short",
      text: "short ids acknowledged",
    });
    const rawBodyPending = registerPendingConversationTurn({
      conversationRef,
      sessionId,
      timeoutMs: 5_000,
    });
    rawBodyPending.setOutboundMessageId("reef-outbound-raw-body");
    rawBodyPending.markReady();
    await expect(
      capturePendingConversationTurnReply({
        cfg,
        ctx: {
          AgentId: "main",
          SessionKey: sessionKey,
          ChatType: "direct",
          Provider: "reef",
          InboundAccessAuthorized: true,
          OriginatingChannel: "reef",
          OriginatingTo: "reef:peer-agent",
          NativeDirectUserId: "peer-agent",
          MessageSid: "reef-inbound-raw-body",
          ReplyToId: "reef-outbound-raw-body",
          RawBody: "raw body acknowledged",
          BodyForAgent: "   ",
        } as FinalizedMsgContext,
      }),
    ).resolves.toBe(true);
    await expect(rawBodyPending.wait()).resolves.toMatchObject({
      text: "raw body acknowledged",
    });
    const messages = (await loadTranscriptEvents({ agentId: "main", sessionId, storePath }))
      .map((event) => (event as { message?: Record<string, unknown> }).message)
      .filter((message): message is Record<string, unknown> => Boolean(message));
    expect(messages).toContainEqual(
      expect.objectContaining({ role: "user", content: "short ids acknowledged" }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({ role: "user", content: "raw body acknowledged" }),
    );
  });

  it("durably records same-session replies without splitting the tool call/result", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-conversation-capture-"));
    tempDirs.push(stateDir);
    const storePath = path.join(stateDir, "sessions.json");
    const sessionKey = "agent:main:reef:direct:peer-agent";
    const sessionId = "reef-session";
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId,
        updatedAt: 100,
        chatType: "direct",
        deliveryContext: {
          channel: "reef",
          accountId: "default",
          to: "reef:peer-agent",
        },
        origin: {
          provider: "reef",
          accountId: "default",
          nativeDirectUserId: "peer-agent",
        },
      },
    );
    const conversationRef = buildConversationRef({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "peer-agent",
    });
    const pending = registerPendingConversationTurn({
      conversationRef,
      sessionId,
      sourceSessionId: sessionId,
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("reef-outbound-same-session");
    pending.markReady();

    const captured = await capturePendingConversationTurnReply({
      cfg,
      ctx: {
        AgentId: "main",
        SessionKey: sessionKey,
        ChatType: "direct",
        Provider: "reef",
        InboundAccessAuthorized: true,
        OriginatingChannel: "reef",
        OriginatingTo: "reef:peer-agent",
        NativeDirectUserId: "peer-agent",
        MessageSidFull: "reef-inbound-same-session",
        ReplyToIdFull: "reef-outbound-same-session",
        RawBody: "same-session ack",
        BodyForAgent: "same-session ack",
      } as FinalizedMsgContext,
    });

    expect(captured).toBe(true);
    const reply = await pending.wait();
    expect(reply).toMatchObject({
      conversationRef,
      text: "same-session ack",
      transcriptArtifactId: expect.stringMatching(/^conversation-turn-reply-/u),
    });
    expect(reply).not.toHaveProperty("transcriptMessageId");
    const events = await loadTranscriptEvents({ agentId: "main", sessionId, storePath });
    const messages = events.filter((event) => "message" in (event as Record<string, unknown>));
    expect(messages).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "custom",
        customType: "openclaw.conversation-turn-reply",
        appendMode: "side",
        data: expect.objectContaining({
          conversationRef,
          messageId: "reef-inbound-same-session",
          replyToId: "reef-outbound-same-session",
          message: expect.objectContaining({ role: "user", content: "same-session ack" }),
        }),
      }),
    );
  });

  it("scopes short transport idempotency to each external conversation", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-conversation-capture-"));
    tempDirs.push(stateDir);
    const storePath = path.join(stateDir, "sessions.json");
    const sessionKey = "agent:main:main";
    const sessionId = "shared-main-session";
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId,
        updatedAt: 100,
        chatType: "direct",
        deliveryContext: {
          channel: "reef",
          accountId: "default",
          to: "reef:peer-a",
        },
        origin: {
          provider: "reef",
          accountId: "default",
          nativeDirectUserId: "peer-a",
        },
      },
    );

    const capture = async (peer: string, outboundMessageId: string, text: string) => {
      const conversationRef = buildConversationRef({
        channel: "reef",
        accountId: "default",
        kind: "direct",
        peerId: peer,
      });
      const pending = registerPendingConversationTurn({
        conversationRef,
        sessionId,
        timeoutMs: 5_000,
      });
      pending.setOutboundMessageId(outboundMessageId);
      pending.markReady();
      await expect(
        capturePendingConversationTurnReply({
          cfg,
          ctx: {
            AgentId: "main",
            SessionKey: sessionKey,
            ChatType: "direct",
            Provider: "reef",
            InboundAccessAuthorized: true,
            From: `reef:${peer}`,
            OriginatingChannel: "reef",
            OriginatingTo: "reef:self",
            NativeDirectUserId: peer,
            MessageSid: "short-id-1",
            ReplyToId: outboundMessageId,
            RawBody: text,
            BodyForAgent: text,
          } as FinalizedMsgContext,
        }),
      ).resolves.toBe(true);
      await expect(pending.wait()).resolves.toMatchObject({ conversationRef, text });
    };

    await capture("peer-a", "outbound-a", "reply from a");
    await capture("peer-b", "outbound-b", "reply from b");

    const userMessages = (await loadTranscriptEvents({ agentId: "main", sessionId, storePath }))
      .map((event) => (event as { message?: Record<string, unknown> }).message)
      .filter((message): message is Record<string, unknown> => message?.role === "user");
    expect(userMessages).toHaveLength(2);
    expect(userMessages.map((message) => message.content)).toEqual([
      "reply from a",
      "reply from b",
    ]);
  });

  it("captures threaded channel replies before normal agent dispatch", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-conversation-capture-"));
    tempDirs.push(stateDir);
    const storePath = path.join(stateDir, "sessions.json");
    const sessionKey = "agent:main:discord:channel:ops-room:thread:user-context";
    const sessionId = "discord-thread-session";
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId,
        updatedAt: 100,
        chatType: "channel",
        groupId: "ops-room",
        deliveryContext: {
          channel: "discord",
          accountId: "default",
          to: "channel:ops-room",
          threadId: "user-context",
        },
        origin: {
          provider: "discord",
          accountId: "default",
          nativeChannelId: "ops-room",
        },
      },
    );
    const conversationRef = buildConversationRef({
      channel: "discord",
      accountId: "default",
      kind: "channel",
      peerId: "ops-room",
      threadId: "user-context",
    });
    const pending = registerPendingConversationTurn({
      conversationRef,
      sessionId,
      threadId: "user-context",
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("discord-outbound-full");
    pending.markReady();

    const captured = await capturePendingConversationTurnReply({
      cfg,
      ctx: {
        AgentId: "main",
        SessionKey: sessionKey,
        ChatType: "channel",
        Provider: "discord",
        InboundAccessAuthorized: true,
        From: "discord:channel:ops-room",
        To: "channel:ops-room",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:ops-room",
        NativeChannelId: "ops-room",
        MessageThreadId: "user-context",
        ThreadParentId: "unpersisted-parent-id",
        MessageSidFull: "discord-inbound-full",
        ReplyToIdFull: "discord-outbound-full",
        SenderId: "member-1",
        SenderName: "Member One",
        RawBody: "channel ack",
        BodyForAgent: "channel ack",
      } as FinalizedMsgContext,
    });

    expect(captured).toBe(true);
    await expect(pending.wait()).resolves.toMatchObject({
      conversationRef,
      messageId: "discord-inbound-full",
      replyToId: "discord-outbound-full",
      threadId: "user-context",
      text: "channel ack",
    });
    const messages = (await loadTranscriptEvents({ agentId: "main", sessionId, storePath }))
      .map((event) => (event as { message?: Record<string, unknown> }).message)
      .filter((message): message is Record<string, unknown> => Boolean(message));
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: "channel ack",
        __openclaw: expect.objectContaining({
          senderId: "member-1",
          senderName: "Member One",
        }),
      }),
    );
  });

  it("falls through without claiming when the inbound session cannot be resolved", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-conversation-capture-"));
    tempDirs.push(stateDir);
    const sessionKey = "agent:main:reef:direct:missing";
    const conversationRef = buildConversationRef({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "missing",
    });
    const pending = registerPendingConversationTurn({
      conversationRef,
      sessionId: "session-main",
      timeoutMs: 5_000,
    });
    pending.setOutboundMessageId("outbound-missing");
    pending.markReady();

    await expect(
      capturePendingConversationTurnReply({
        cfg: { session: { store: path.join(stateDir, "sessions.json") } } as OpenClawConfig,
        ctx: {
          SessionKey: sessionKey,
          ChatType: "direct",
          Provider: "reef",
          InboundAccessAuthorized: true,
          OriginatingChannel: "reef",
          OriginatingTo: "reef:missing",
          NativeDirectUserId: "missing",
          MessageSidFull: "inbound-missing",
          ReplyToIdFull: "outbound-missing",
          RawBody: "fall through",
          BodyForAgent: "fall through",
        } as FinalizedMsgContext,
      }),
    ).resolves.toBe(false);
    pending.cancel();
    await expect(pending.wait()).resolves.toBeUndefined();
  });

  it("falls through when the optional capture store lookup throws", async () => {
    await expect(
      capturePendingConversationTurnReply({
        cfg: { session: { store: "\0invalid-store" } } as OpenClawConfig,
        ctx: {
          AgentId: "main",
          SessionKey: "agent:main:reef:direct:peer-agent",
          ChatType: "direct",
          Provider: "reef",
          InboundAccessAuthorized: true,
          OriginatingChannel: "reef",
          OriginatingTo: "reef:peer-agent",
          NativeDirectUserId: "peer-agent",
          MessageSidFull: "reef-inbound-store-failure",
          ReplyToIdFull: "reef-outbound-store-failure",
          RawBody: "ordinary inbound fallback",
          BodyForAgent: "ordinary inbound fallback",
        } as FinalizedMsgContext,
      }),
    ).resolves.toBe(false);
  });
});
