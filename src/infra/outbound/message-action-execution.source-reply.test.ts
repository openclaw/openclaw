// Covers core message-action send fallback, TTS application, and durable send
// policy after plugin preparation is absent.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { annotateSourceDelivery } from "./message-action-execution.js";
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
              sendText: vi.fn().mockResolvedValue({
                channel: "telegram",
                messageId: "m1",
                chatId: "-100123",
              }),
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

const slackSourceContext = {
  currentChannelProvider: "slack",
  currentChannelId: "channel:C123",
};

function runSlackSourceReply(input: Partial<Parameters<typeof runMessageAction>[0]> = {}) {
  return runMessageAction({
    cfg: slackConfig,
    action: "send",
    toolContext: slackSourceContext,
    messageActionAuthorization: {
      requesterAccountId: "default",
      toolContext: { ...slackSourceContext, currentSourceTurnId: "source-turn-1" },
    },
    sessionKey: "agent:main:slack:channel:C123",
    defaultAccountId: "default",
    sourceReplyDeliveryMode: "message_tool_only",
    dryRun: false,
    ...input,
    params: {
      channel: "slack",
      target: "channel:C123",
      message: "visible source reply",
      ...input.params,
    },
  });
}

describe("runMessageAction core send routing", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    ttsMocks.maybeApplyTtsToPayload
      .mockReset()
      .mockImplementation(async (params: { payload: unknown }) => params.payload);
  });

  // Regression for #157277: a Telegram topic send reports the bare chat id at
  // top level with the topic only inside the receipt. The delivered reply must
  // still be recognized as delivered to the topic-qualified current source.
  it("marks a Telegram topic reply as current-source when the receipt reports the topic", async () => {
    const targetIdentity = (raw: string) => {
      const body = raw.replace(/^telegram:/i, "");
      const index = body.indexOf(":topic:");
      return {
        chatId: index === -1 ? body : body.slice(0, index),
        threadId: index === -1 ? undefined : body.slice(index + ":topic:".length),
      };
    };
    const matchesToolContextTarget = ({
      target,
      toolContext,
    }: {
      target: string;
      toolContext: { currentMessagingTarget?: string; currentChannelId?: string };
    }) => {
      const delivered = targetIdentity(target);
      return [toolContext.currentMessagingTarget, toolContext.currentChannelId].some((current) => {
        if (typeof current !== "string") {
          return false;
        }
        const source = targetIdentity(current);
        return delivered.chatId === source.chatId && delivered.threadId === source.threadId;
      });
    };
    const telegramPlugin: ChannelPlugin = {
      ...createOutboundTestPlugin({
        id: "telegram",
        messaging: { targetResolver: { looksLikeId: () => true } },
        outbound: { deliveryMode: "direct", sendText: vi.fn() },
      }),
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      threading: {
        matchesToolContextTarget,
        resolveCurrentChannelId: ({ to, threadId }) => {
          if (threadId == null) {
            return to;
          }
          return targetIdentity(to).threadId != null ? to : `${to}:topic:${threadId}`;
        },
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
    );

    const input = {
      cfg: {},
      action: "send" as const,
      params: {
        channel: "telegram",
        target: "telegram:-100123:topic:77",
        message: "visible source reply",
      },
      messageActionAuthorization: {
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "telegram",
          currentChannelId: "telegram:-100123:topic:77",
          currentThreadTs: "77",
          currentSourceTurnId: "source-turn-1",
        },
      },
      sessionKey: "agent:main:telegram:group:telegram:-100123:topic:77",
      defaultAccountId: "default",
    };
    const result = await annotateSourceDelivery(
      {
        kind: "send" as const,
        channel: "telegram" as const,
        action: "send" as const,
        handledBy: "core" as const,
        to: input.params.target,
        payload: {
          channel: "telegram",
          messageId: "m1",
          chatId: "-100123",
          receipt: { platformMessageIds: ["m1"], parts: [], threadId: "77", sentAt: 1 },
        },
        dryRun: false,
      },
      {
        cfg: {},
        params: input.params,
        channel: "telegram" as const,
        channelPlugin: telegramPlugin,
        mediaAccess: { localRoots: [] },
        accountId: "default",
        input,
        dryRun: false,
      },
      false,
    );

    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
  });
  it("marks explicit sends to the trusted current source conversation", async () => {
    registerSlackTextPlugin();

    const result = await runSlackSourceReply();

    expect(result.kind).toBe("send");
    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it("marks automatic-mode Slack sends to the trusted current source conversation", async () => {
    registerSlackTextPlugin();

    const result = await runSlackSourceReply({
      toolContext: undefined,
      sourceReplyDeliveryMode: "automatic",
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

  it("does not mark a message-scoped reply that enters a new thread as current-source", async () => {
    registerSlackTextPlugin();

    const result = await runSlackSourceReply({
      params: { message: "reply in a new thread", replyTo: "1710000000.9999" },
    });

    expect(result.kind).toBe("send");
    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });

  it("does not trust ambient routing when the authorized source differs", async () => {
    registerSlackTextPlugin();

    const result = await runSlackSourceReply({
      params: { message: "not the authorized source" },
      messageActionAuthorization: {
        requesterAccountId: "default",
        toolContext: {
          ...slackSourceContext,
          currentChannelId: "channel:C999",
          currentSourceTurnId: "source-turn-1",
        },
      },
    });

    expect(result.kind).toBe("send");
    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });

  it("does not mark same-target sends through another account", async () => {
    registerSlackTextPlugin(["default", "other"]);

    const result = await runSlackSourceReply({
      params: { accountId: "other", message: "cross-account reply" },
    });

    expect(result.kind).toBe("send");
    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });

  it("does not mark same-target sends to another thread", async () => {
    registerSlackTextPlugin();

    const result = await runSlackSourceReply({
      params: { threadId: "other-thread", message: "thread-only reply" },
      toolContext: { ...slackSourceContext, currentThreadTs: "source-thread" },
      messageActionAuthorization: {
        requesterAccountId: "default",
        toolContext: {
          ...slackSourceContext,
          currentThreadTs: "source-thread",
          currentSourceTurnId: "source-turn-1",
        },
      },
      sessionKey: "agent:main:slack:channel:C123:thread:source-thread",
    });

    expect(result.kind).toBe("send");
    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });
});
