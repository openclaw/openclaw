import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { MessageActionRunResult } from "../../infra/outbound/message-action-runner.js";
import {
  DEFAULT_GATEWAY_HTTP_TOOL_DENY,
  GATEWAY_OWNER_ONLY_CORE_TOOLS,
} from "../../security/dangerous-tools.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../harness/hook-helpers.js";
import {
  createConversationsListTool,
  createConversationsSendTool,
  createConversationsTurnTool,
} from "./conversation-tools.js";

const conversation = {
  conversationRef: "conv_0123456789abcdef0123456789abcdef",
  channel: "reef",
  accountId: "default",
  kind: "direct" as const,
  target: "reef:peer-agent",
  sessionId: "shared-main-session",
  sessionKey: "agent:main:main",
  role: "participant" as const,
  firstSeenAt: 100,
  lastSeenAt: 200,
};

function sentResult(): Extract<MessageActionRunResult, { kind: "send" }> {
  return {
    kind: "send",
    channel: "reef",
    action: "send",
    to: "reef:peer-agent",
    handledBy: "plugin",
    payload: {},
    sendResult: {
      channel: "reef",
      to: "reef:peer-agent",
      via: "direct",
      mediaUrl: null,
      result: { messageId: "reef-outbound-1" },
    },
    dryRun: false,
  };
}

function createDeps() {
  const appendAssistantMessage = vi.fn<typeof appendAssistantMessageToSessionTranscript>();
  const callGatewayMock = vi.fn(async (_params: unknown) => ({
    status: "replied" as const,
    conversationRef: conversation.conversationRef,
    channel: "reef",
    messageId: "reef-outbound-1",
    correlationPersisted: true,
    reply: {
      conversationRef: conversation.conversationRef,
      messageId: "reef-inbound-1",
      replyToId: "reef-outbound-1",
      text: "peer acknowledged",
      timestamp: 300,
    },
  }));
  appendAssistantMessage.mockResolvedValue({
    ok: true,
    sessionFile: "sqlite:main:shared-main-session",
    messageId: "transcript-outbound-1",
  });
  return {
    appendAssistantMessage,
    beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    callGateway: callGatewayMock as never,
    callGatewayMock,
    listConversations: vi.fn(() => [conversation]),
    resolveConversation: vi.fn((): typeof conversation | undefined => conversation),
    runMessageAction: vi.fn(async () => sentResult()),
  };
}

describe("conversation tools", () => {
  it("lists opaque external addresses independently from sessions", async () => {
    const deps = createDeps();
    const result = await createConversationsListTool({ agentId: "main" }, deps).execute("list", {
      channel: "reef",
    });

    expect(deps.listConversations).toHaveBeenCalledWith(
      { agentId: "main" },
      { channel: "reef", limit: 50 },
    );
    expect(result.details).toEqual({
      conversations: [
        {
          conversationRef: conversation.conversationRef,
          channel: "reef",
          accountId: "default",
          kind: "direct",
          target: "reef:peer-agent",
          firstSeenAt: 100,
          lastSeenAt: 200,
        },
      ],
    });
    expect(result.details).not.toHaveProperty("conversations.0.sessionId");
    expect(result.details).not.toHaveProperty("conversations.0.sessionKey");
  });

  it("resolves conversation addresses from the configured agent store", async () => {
    const deps = createDeps();
    await createConversationsListTool(
      {
        agentId: "agent-b",
        config: { session: { store: "/var/openclaw/{agentId}/sessions.json" } },
      },
      deps,
    ).execute("list", {});

    expect(deps.listConversations).toHaveBeenCalledWith(
      { agentId: "agent-b", storePath: "/var/openclaw/agent-b/sessions.json" },
      { limit: 50 },
    );
  });

  it("sends to the exact channel target without invoking the backing session", async () => {
    const deps = createDeps();
    const result = await createConversationsSendTool(
      { agentId: "main", agentSessionKey: "agent:main:telegram:direct:operator", config: {} },
      deps,
    ).execute("send", {
      conversationRef: conversation.conversationRef,
      message: "hello peer",
    });

    expect(deps.runMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "send",
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:operator",
        transcriptMirror: expect.objectContaining({
          expectedSessionId: conversation.sessionId,
          sessionKey: conversation.sessionKey,
          deliveryMirror: expect.objectContaining({
            kind: "conversation-send",
            status: "delivered",
          }),
        }),
        params: expect.objectContaining({
          channel: "reef",
          to: "reef:peer-agent",
          accountId: "default",
          message: "hello peer",
        }),
      }),
    );
    expect(result.details).toMatchObject({
      status: "sent",
      conversationRef: conversation.conversationRef,
      messageId: "reef-outbound-1",
      correlationPersisted: true,
    });
    expect(deps.appendAssistantMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        expectedSessionId: conversation.sessionId,
        sessionKey: conversation.sessionKey,
        text: "hello peer",
        deliveryMirror: {
          kind: "conversation-send",
          status: "pending",
          channel: "reef",
          conversationRef: conversation.conversationRef,
          replay: "backing-session",
        },
      }),
    );
    expect(deps.appendAssistantMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedSessionId: conversation.sessionId,
        sessionKey: conversation.sessionKey,
        text: "hello peer",
        deliveryMirror: {
          kind: "conversation-send",
          status: "delivered",
          channel: "reef",
          conversationRef: conversation.conversationRef,
          messageId: "reef-outbound-1",
          replay: "backing-session",
        },
        deliveryMirrorUpdateMode: "marker-only",
      }),
    );
  });

  it("recognizes a same-session alias by canonical session id", async () => {
    const deps = createDeps();

    await createConversationsSendTool(
      {
        agentId: "main",
        agentSessionId: conversation.sessionId,
        agentSessionKey: "agent:main:alias-for-main",
        config: {},
      },
      deps,
    ).execute("send", {
      conversationRef: conversation.conversationRef,
      message: "same-session hello",
    });

    expect(deps.appendAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryMirror: {
          kind: "conversation-send",
          status: "delivered",
          channel: "reef",
          conversationRef: conversation.conversationRef,
          messageId: "reef-outbound-1",
        },
      }),
    );
  });

  it("persists the outbound text as a durable backing-conversation artifact", async () => {
    await withTempDir({ prefix: "openclaw-conversation-outbound-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      try {
        await upsertSessionEntry(
          { agentId: "main", sessionKey: conversation.sessionKey, storePath },
          {
            sessionId: conversation.sessionId,
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
        const deps = createDeps();
        deps.appendAssistantMessage.mockImplementation(
          async (params) => await appendAssistantMessageToSessionTranscript(params),
        );

        await createConversationsSendTool(
          {
            agentId: "main",
            agentSessionKey: "agent:main:telegram:direct:operator",
            config: { session: { store: storePath } },
          },
          deps,
        ).execute("send", {
          conversationRef: conversation.conversationRef,
          message: "durable hello",
        });

        const messages = (
          await loadTranscriptEvents({
            agentId: "main",
            sessionId: conversation.sessionId,
            storePath,
          })
        ).flatMap((event) =>
          event && typeof event === "object" && "message" in event ? [event.message] : [],
        );
        expect(messages).toContainEqual(
          expect.objectContaining({
            role: "assistant",
            provider: "openclaw",
            model: "delivery-mirror",
            content: [{ type: "text", text: "durable hello" }],
            openclawDeliveryMirror: {
              kind: "conversation-send",
              status: "delivered",
              channel: "reef",
              conversationRef: conversation.conversationRef,
              messageId: "reef-outbound-1",
              replay: "backing-session",
            },
          }),
        );
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });

  it("persists the exact transport-normalized text", async () => {
    const deps = createDeps();
    deps.runMessageAction.mockResolvedValueOnce({
      ...sentResult(),
      deliveredText: "[Peer] hello there",
    });

    await createConversationsSendTool({ agentId: "main", config: {} }, deps).execute("send", {
      conversationRef: conversation.conversationRef,
      message: "hello peer",
    });

    expect(deps.appendAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "[Peer] hello there",
        deliveryMirrorUpdateMode: "replace",
      }),
    );
  });

  it("does not expose a message when its durable intent cannot be written", async () => {
    const deps = createDeps();
    deps.appendAssistantMessage.mockResolvedValueOnce({
      ok: false,
      reason: "session rebound",
      code: "session-rebound",
    });

    await expect(
      createConversationsSendTool({ agentId: "main", config: {} }, deps).execute("send", {
        conversationRef: conversation.conversationRef,
        message: "must stay local",
      }),
    ).rejects.toThrow("delivery intent was not persisted");
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("rejects non-send and dry-run results after persisting hidden delivery intent", async () => {
    const nonSendDeps = {
      ...createDeps(),
      runMessageAction: vi.fn(
        async (): Promise<MessageActionRunResult> => ({
          kind: "action",
          channel: "reef",
          action: "react",
          handledBy: "plugin",
          payload: {},
          dryRun: false,
        }),
      ),
    };
    await expect(
      createConversationsSendTool({ agentId: "main", config: {} }, nonSendDeps).execute("send", {
        conversationRef: conversation.conversationRef,
        message: "must really send",
      }),
    ).rejects.toThrow("unexpected action: action");
    expect(nonSendDeps.appendAssistantMessage).toHaveBeenCalledOnce();
    expect(nonSendDeps.appendAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryMirror: expect.objectContaining({ status: "pending" }),
      }),
    );

    const dryRunDeps = createDeps();
    dryRunDeps.runMessageAction.mockResolvedValueOnce({ ...sentResult(), dryRun: true });
    await expect(
      createConversationsSendTool({ agentId: "main", config: {} }, dryRunDeps).execute("send", {
        conversationRef: conversation.conversationRef,
        message: "must not be dry run",
      }),
    ).rejects.toThrow("no message was sent");
    expect(dryRunDeps.appendAssistantMessage).toHaveBeenCalledOnce();
  });

  it("returns the correlated peer reply inline", async () => {
    const deps = createDeps();
    const result = await createConversationsTurnTool(
      {
        agentId: "main",
        agentSessionId: "operator-session",
        agentSessionKey: "agent:main:telegram:direct:operator",
        config: {},
      },
      deps,
    ).execute("turn", {
      conversationRef: conversation.conversationRef,
      message: "please acknowledge",
      timeoutSeconds: 12,
    });

    expect(deps.callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "conversations.turn",
        config: {},
        timeoutMs: 32_000,
        params: expect.objectContaining({
          agentId: "main",
          sourceSessionId: "operator-session",
          sourceSessionKey: "agent:main:telegram:direct:operator",
          turnId: expect.any(String),
          conversationRef: conversation.conversationRef,
          message: "please acknowledge",
          timeoutMs: 12_000,
        }),
      }),
    );
    expect(deps.resolveConversation).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      status: "replied",
      reply: { text: "peer acknowledged", replyToId: "reef-outbound-1" },
    });

    const call = deps.callGatewayMock.mock.calls[0]?.[0] as {
      onSignalAbort?: (
        request: (method: string, params: unknown, options: unknown) => Promise<unknown>,
      ) => Promise<void>;
      params?: { turnId?: string };
    };
    const request = vi.fn(async () => ({ cancelled: true }));
    await call.onSignalAbort?.(request);
    expect(request).toHaveBeenCalledWith(
      "conversations.turn.cancel",
      { turnId: call.params?.turnId },
      { timeoutMs: 5_000 },
    );
  });

  it("rejects unknown conversation references before delivery", async () => {
    const deps = createDeps();
    deps.resolveConversation.mockReturnValue(undefined);
    await expect(
      createConversationsSendTool({ agentId: "main", config: {} }, deps).execute("send", {
        conversationRef: "conv_ffffffffffffffffffffffffffffffff",
        message: "hello",
      }),
    ).rejects.toThrow("Conversation not found");
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("rejects channels without correlated-turn support before delivery", async () => {
    const deps = createDeps();
    deps.callGatewayMock.mockRejectedValueOnce(
      new Error("Channel matrix does not support correlated conversation turns"),
    );

    await expect(
      createConversationsTurnTool({ agentId: "main", config: {} }, deps).execute("turn", {
        conversationRef: conversation.conversationRef,
        message: "must not send",
      }),
    ).rejects.toThrow("does not support correlated conversation turns");
    expect(deps.callGatewayMock).toHaveBeenCalledOnce();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("keeps conversation discovery and delivery owner-only", async () => {
    const deps = createDeps();
    await expect(
      createConversationsListTool({ agentId: "main", senderIsOwner: false }, deps).execute(
        "list",
        {},
      ),
    ).rejects.toThrow("require owner access");
    await expect(
      createConversationsSendTool(
        { agentId: "main", senderIsOwner: false, config: {} },
        deps,
      ).execute("send", {
        conversationRef: conversation.conversationRef,
        message: "blocked",
      }),
    ).rejects.toThrow("require owner access");
    await expect(
      createConversationsTurnTool(
        { agentId: "main", senderIsOwner: false, config: {} },
        deps,
      ).execute("turn", {
        conversationRef: conversation.conversationRef,
        message: "blocked",
      }),
    ).rejects.toThrow("require owner access");
    expect(deps.listConversations).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
    for (const name of ["conversations_list", "conversations_send", "conversations_turn"]) {
      expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain(name);
      expect(DEFAULT_GATEWAY_HTTP_TOOL_DENY).toContain(name);
    }
  });
});
