// Covers core message-action send fallback, TTS application, and durable send
// policy after plugin preparation is absent.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (params: { payload: unknown }) => params.payload),
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: ttsMocks.maybeApplyTtsToPayload,
}));

const slackConfig = {
  channels: {
    slack: {
      enabled: true,
    },
  },
} as OpenClawConfig;

const telegramConfig = {
  channels: {
    telegram: {
      enabled: true,
    },
  },
} as OpenClawConfig;

function registerSlackTextPlugin(accountIds: string[] = ["default"]) {
  const sendText = vi.fn().mockResolvedValue({
    channel: "slack",
    messageId: "m1",
    chatId: "C123",
  });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({
            id: "slack",
            messaging: { normalizeTarget: (target) => target.replace(/^channel:/, "") },
            outbound: {
              deliveryMode: "direct",
              sendText,
            },
          }),
          config: {
            listAccountIds: () => accountIds,
            resolveAccount: () => ({ enabled: true }),
            isConfigured: () => true,
          },
          threading: { threadAddressing: "message" },
        },
      },
    ]),
  );
  return sendText;
}

function registerTelegramTextPlugin(
  matchesToolContextTarget: NonNullable<
    NonNullable<ChannelPlugin["threading"]>["matchesToolContextTarget"]
  >,
  sendResult: Record<string, unknown> = { channel: "telegram", messageId: "m1", chatId: "-100123" },
) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({
            id: "telegram",
            messaging: { targetResolver: { looksLikeId: () => true } },
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn().mockResolvedValue(sendResult),
            },
          }),
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({ enabled: true }),
            isConfigured: () => true,
          },
          threading: { matchesToolContextTarget },
        },
      },
    ]),
  );
}

describe("runMessageAction core send routing", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    ttsMocks.maybeApplyTtsToPayload
      .mockReset()
      .mockImplementation(async (params: { payload: unknown }) => params.payload);
  });
  it("marks explicit sends to the trusted current source conversation", async () => {
    registerSlackTextPlugin();

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:C123",
        message: "visible source reply",
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "channel:C123",
      },
      messageActionAuthorization: {
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C123",
          currentSourceTurnId: "source-turn-1",
        },
      },
      sessionKey: "agent:main:slack:channel:C123",
      defaultAccountId: "default",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it("marks automatic-mode Slack sends to the trusted current source conversation", async () => {
    registerSlackTextPlugin();

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:C123",
        message: "visible source reply",
      },
      messageActionAuthorization: {
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C123",
          currentSourceTurnId: "source-turn-1",
        },
      },
      sessionKey: "agent:main:slack:channel:C123",
      defaultAccountId: "default",
      sourceReplyDeliveryMode: "automatic",
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it.each([
    {
      name: "an equivalent raw current-chat target",
      target: "-100123",
      currentChannelId: "telegram:-100123",
      matcherResult: true,
      expectedRoute: "current-source",
    },
    {
      name: "a different chat",
      target: "-100456",
      currentChannelId: "telegram:-100123",
      matcherResult: false,
      expectedRoute: undefined,
    },
    {
      name: "a different topic",
      target: "-100123:topic:78",
      currentChannelId: "telegram:-100123:topic:77",
      matcherResult: false,
      expectedRoute: undefined,
    },
  ])("uses the Telegram target matcher for $name", async (testCase) => {
    const matchesToolContextTarget = vi.fn(() => testCase.matcherResult);
    registerTelegramTextPlugin(matchesToolContextTarget);

    const toolContext = {
      currentChannelProvider: "telegram",
      currentChannelId: testCase.currentChannelId,
      currentSourceTurnId: "source-turn-1",
    };
    const result = await runMessageAction({
      cfg: telegramConfig,
      action: "send",
      params: {
        channel: "telegram",
        target: testCase.target,
        message: "visible source reply",
      },
      toolContext,
      messageActionAuthorization: {
        requesterAccountId: "default",
        toolContext,
      },
      sessionKey: `agent:main:telegram:group:${testCase.currentChannelId}`,
      defaultAccountId: "default",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBe(
      testCase.expectedRoute,
    );
    expect(matchesToolContextTarget).toHaveBeenCalledWith({
      target: testCase.target,
      toolContext,
    });
  });

  it("marks a Telegram topic source reply current-source from a thread-losing transport receipt", async () => {
    const matchesToolContextTarget: NonNullable<
      NonNullable<ChannelPlugin["threading"]>["matchesToolContextTarget"]
    > = ({ target, toolContext }) => {
      const parse = (value: string): { chatId: string; thread?: string } => {
        const stripped = value.replace(/^(?:telegram|tg):/i, "");
        const match = /^(.+?):(?:(?:direct-topic|topic):)?(\d+)$/.exec(stripped);
        return match
          ? { chatId: match[1] ?? stripped, thread: match[2] ?? undefined }
          : { chatId: stripped };
      };
      return [toolContext.currentMessagingTarget, toolContext.currentChannelId]
        .filter((current): current is string => Boolean(current))
        .some((current) => {
          const requested = parse(target);
          const existing = parse(current);
          return (
            requested.chatId === existing.chatId &&
            (requested.thread ?? undefined) === (existing.thread ?? undefined)
          );
        });
    };
    registerTelegramTextPlugin(matchesToolContextTarget, {
      channel: "telegram",
      messageId: "m1",
      chatId: "-100123",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ messageId: "m1", chatId: "-100123" }],
        threadId: "77",
      }),
    });

    const toolContext = {
      currentChannelProvider: "telegram",
      currentChannelId: "telegram:-100123:topic:77",
      currentThreadTs: "77",
      currentSourceTurnId: "source-turn-1",
    };
    const result = await runMessageAction({
      cfg: telegramConfig,
      action: "send",
      params: {
        channel: "telegram",
        target: "telegram:-100123:topic:77",
        message: "visible topic source reply",
      },
      toolContext,
      messageActionAuthorization: {
        requesterAccountId: "default",
        toolContext,
      },
      sessionKey: "agent:main:telegram:group:telegram:-100123:topic:77",
      defaultAccountId: "default",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBe(
      "current-source",
    );
  });

  it("does not mark a message-scoped reply that enters a new thread as current-source", async () => {
    registerSlackTextPlugin();

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:C123",
        message: "reply in a new thread",
        replyTo: "1710000000.9999",
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "channel:C123",
      },
      messageActionAuthorization: {
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C123",
          currentSourceTurnId: "source-turn-1",
        },
      },
      sessionKey: "agent:main:slack:channel:C123",
      defaultAccountId: "default",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });

  it("does not trust ambient routing when the authorized source differs", async () => {
    registerSlackTextPlugin();

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:C123",
        message: "not the authorized source",
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "channel:C123",
      },
      messageActionAuthorization: {
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C999",
          currentSourceTurnId: "source-turn-1",
        },
      },
      sessionKey: "agent:main:slack:channel:C123",
      defaultAccountId: "default",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });

  it("does not mark same-target sends through another account", async () => {
    registerSlackTextPlugin(["default", "other"]);

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        accountId: "other",
        target: "channel:C123",
        message: "cross-account reply",
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "channel:C123",
      },
      messageActionAuthorization: {
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C123",
          currentSourceTurnId: "source-turn-1",
        },
      },
      sessionKey: "agent:main:slack:channel:C123",
      defaultAccountId: "default",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });

  it("does not mark same-target sends to another thread", async () => {
    registerSlackTextPlugin();

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:C123",
        threadId: "other-thread",
        message: "thread-only reply",
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "channel:C123",
        currentThreadTs: "source-thread",
      },
      messageActionAuthorization: {
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C123",
          currentThreadTs: "source-thread",
          currentSourceTurnId: "source-turn-1",
        },
      },
      sessionKey: "agent:main:slack:channel:C123:thread:source-thread",
      defaultAccountId: "default",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });
});
