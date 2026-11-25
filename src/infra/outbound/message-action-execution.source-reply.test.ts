import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelPlugin,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { annotateSourceDelivery } from "./message-action-result-acceptance.js";
import { runMessageAction } from "./message-action-runner.js";
import { registerSlackTextPlugin as registerSlackFixture } from "./message-action-runner.test-support.js";

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (params: { payload: unknown }) => params.payload),
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: ttsMocks.maybeApplyTtsToPayload,
}));

function registerTextPlugin(
  id: string,
  overrides: Partial<ChannelPlugin> = {},
  accountIds = ["default"],
) {
  const plugin: ChannelPlugin = {
    ...createOutboundTestPlugin({
      id,
      messaging: { targetResolver: { looksLikeId: () => true } },
      outbound: { deliveryMode: "direct", sendText: vi.fn() },
    }),
    config: {
      listAccountIds: () => accountIds,
      resolveAccount: () => ({ enabled: true }),
      isConfigured: () => true,
    },
    ...overrides,
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: id, source: "test", plugin }]));
  return plugin;
}

function registerSlackTextPlugin(accountIds = ["default"]) {
  registerSlackFixture(accountIds, undefined, "direct", {
    normalizeTarget: (target) => target.replace(/^channel:/, ""),
  });
}

type ActionInput = Parameters<typeof runMessageAction>[0];
function sourceInput(
  toolContext: ChannelThreadingToolContext,
  input: Partial<ActionInput> = {},
): ActionInput {
  return {
    cfg: {},
    action: "send",
    params: {},
    toolContext,
    messageActionAuthorization: {
      requesterAccountId: "default",
      toolContext: { currentSourceTurnId: "source-turn-1", ...toolContext },
    },
    defaultAccountId: "default",
    sourceReplyDeliveryMode: "message_tool_only",
    dryRun: false,
    ...input,
  };
}

const slackSourceContext = {
  currentChannelProvider: "slack",
  currentChannelId: "channel:C123",
};

function runSlackSourceReply(input: Partial<ActionInput> = {}) {
  return runMessageAction(
    sourceInput(slackSourceContext, {
      cfg: { channels: { slack: { enabled: true } } } as OpenClawConfig,
      sessionKey: "agent:main:slack:channel:C123",
      ...input,
      params: {
        channel: "slack",
        target: "channel:C123",
        message: "visible source reply",
        ...input.params,
      },
    }),
  );
}

describe("runMessageAction core send routing", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    ttsMocks.maybeApplyTtsToPayload
      .mockReset()
      .mockImplementation(async (params: { payload: unknown }) => params.payload);
  });

  it.each(["off", "first", "all"] as const)(
    "delivers the first implicit auto-thread reply to the thread with replyToMode=%s",
    async (replyToMode) => {
      const sendText = vi.fn(async ({ to }: { to: string }) => ({
        channel: "discord",
        messageId: "sent",
        channelId: to.replace(/^channel:/, ""),
      }));
      registerTextPlugin("discord", {
        outbound: { deliveryMode: "direct", sendText },
        threading: {
          matchesToolContextTarget: ({ target, toolContext }) =>
            [toolContext.currentChannelId, toolContext.currentMessagingTarget].some(
              (current) => current?.replace(/^channel:/, "") === target.replace(/^channel:/, ""),
            ),
        },
      });
      const toolContext = {
        currentChannelProvider: "discord",
        currentChatType: "channel" as const,
        currentChannelId: "channel:parent",
        currentMessagingTarget: "channel:thread",
        currentMessageId: "thread",
        currentSourceTurnId: "source-turn-1",
        replyToMode,
        hasRepliedRef: { value: false },
      };
      const input = sourceInput(toolContext, { sessionKey: "agent:main:discord:channel:thread" });
      const result = await runMessageAction({
        ...input,
        params: { channel: "discord", message: "first thread reply" },
      });
      expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ to: "channel:thread" }));
      expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });

      sendText.mockClear();
      const parentResult = await runMessageAction({
        ...input,
        params: { channel: "discord", target: "channel:parent", message: "explicit parent reply" },
      });
      expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ to: "channel:parent" }));
      expect(parentResult.payload).not.toHaveProperty("sourceReplyRoute");
    },
  );

  // #157277: the transport reports a bare chat ID; the receipt supplies its topic.
  it("marks a Telegram topic reply as current-source when the receipt reports the topic", async () => {
    const topicTarget = "telegram:-100123:topic:77";
    const normalizeTarget = (target: string) => target.replace(/^telegram:/i, "");
    const telegramPlugin = registerTextPlugin("telegram", {
      threading: {
        matchesToolContextTarget: ({ target, toolContext }) =>
          [toolContext.currentMessagingTarget, toolContext.currentChannelId].some(
            (current) =>
              typeof current === "string" && normalizeTarget(current) === normalizeTarget(target),
          ),
        resolveCurrentChannelId: ({ to, threadId }) =>
          threadId == null || to.includes(":topic:") ? to : `${to}:topic:${threadId}`,
      },
    });

    const input = sourceInput(
      {
        currentChannelProvider: "telegram",
        currentChannelId: topicTarget,
        currentThreadTs: "77",
      },
      {
        params: {
          channel: "telegram",
          target: topicTarget,
          message: "visible source reply",
        },
        sessionKey: "agent:main:telegram:group:telegram:-100123:topic:77",
      },
    );
    const result = await annotateSourceDelivery(
      {
        kind: "send" as const,
        channel: "telegram" as const,
        action: "send" as const,
        handledBy: "core" as const,
        to: topicTarget,
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
    registerTextPlugin("telegram", {
      outbound: {
        deliveryMode: "direct",
        sendText: vi
          .fn()
          .mockResolvedValue({ channel: "telegram", messageId: "m1", chatId: "-100123" }),
      },
      threading: { matchesToolContextTarget },
    });

    const toolContext = {
      currentChannelProvider: "telegram",
      currentChannelId: testCase.currentChannelId,
      currentSourceTurnId: "source-turn-1",
    };
    const result = await runMessageAction(
      sourceInput(toolContext, {
        cfg: { channels: { telegram: { enabled: true } } } as OpenClawConfig,
        params: {
          channel: "telegram",
          target: testCase.target,
          message: "visible source reply",
        },
        sessionKey: `agent:main:telegram:group:${testCase.currentChannelId}`,
      }),
    );

    expect(result.kind).toBe("send");
    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBe(
      testCase.expectedRoute,
    );
    expect(matchesToolContextTarget).toHaveBeenCalledWith({
      target: testCase.target,
      toolContext,
    });
  });

  it.each([
    {
      name: "a new message-scoped thread",
      input: { params: { message: "reply in a new thread", replyTo: "1710000000.9999" } },
    },
    {
      name: "an ambient route differing from authorization",
      input: {
        params: { message: "not the authorized source" },
        messageActionAuthorization: {
          requesterAccountId: "default",
          toolContext: {
            ...slackSourceContext,
            currentChannelId: "channel:C999",
            currentSourceTurnId: "source-turn-1",
          },
        },
      },
    },
    {
      name: "another account",
      input: { params: { accountId: "other", message: "cross-account reply" } },
      accounts: ["default", "other"],
    },
    {
      name: "another thread",
      input: {
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
      },
    },
  ])("does not mark sends to $name as current-source", async ({ input, accounts }) => {
    registerSlackTextPlugin(accounts);
    const result = await runSlackSourceReply(input);
    expect(result.kind).toBe("send");
    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });
});
