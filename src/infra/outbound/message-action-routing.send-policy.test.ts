// Covers core message-action send fallback, TTS application, and durable send
// policy after plugin preparation is absent.
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelMessageActionName,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { mockFirstRecordArg } from "../../test-utils/mock-call-assertions.js";
import { MessageActionDeniedError } from "./message-action-denial.js";
import { runMessageAction } from "./message-action-runner.js";
import { registerSlackTextPlugin } from "./message-action-runner.test-support.js";

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

describe("runMessageAction core send routing", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    ttsMocks.maybeApplyTtsToPayload
      .mockReset()
      .mockImplementation(async (params: { payload: unknown }) => params.payload);
  });

  it("tells a routeless caller how to recover from a targetless send", async () => {
    const sendText = registerSlackTextPlugin();
    await expect(
      runMessageAction({
        cfg: slackConfig,
        action: "send",
        params: { message: "progress" },
      }),
    ).rejects.toThrow(
      "This turn has no current conversation; pass an explicit target, or reply in normal text.",
    );
    expect(sendText).not.toHaveBeenCalled();
  });

  it.each([
    { name: "agent opt-in", global: false, agent: true, allowed: true },
    { name: "agent restriction", global: true, agent: false, allowed: false },
  ])("preserves $name when WebChat sends to a channel", async (policy) => {
    const sendText = registerSlackTextPlugin();
    const cfg: OpenClawConfig = {
      ...slackConfig,
      tools: {
        message: { crossContext: { allowAcrossProviders: policy.global } },
      },
      agents: {
        entries: {
          main:
            policy.agent === undefined
              ? {}
              : {
                  tools: { message: { crossContext: { allowAcrossProviders: policy.agent } } },
                },
        },
      },
    };
    const send = runMessageAction({
      cfg,
      agentId: "main",
      action: "send",
      params: {
        channel: "slack",
        target: "channel:C123",
        message: "synthetic channel policy probe",
        bestEffort: true,
      },
      toolContext: { currentChannelProvider: "webchat" },
      dryRun: false,
    });
    if (!policy.allowed) {
      await expect(send).rejects.toMatchObject({
        reasonCode: "message_cross_context_denied",
        policyRef: "message-cross-context:provider",
      });
      expect(sendText).not.toHaveBeenCalled();
      return;
    }
    await expect(send).resolves.toMatchObject({
      kind: "send",
      channel: "slack",
      to: "channel:C123",
    });
    expect(sendText).toHaveBeenCalledOnce();
    expect(mockFirstRecordArg(sendText, "send text")).toMatchObject({
      to: "channel:C123",
      text: "synthetic channel policy probe",
    });
  });

  it.each([
    { name: "delivers another conversation by default", target: "channel:C999" },
    { name: "refuses another conversation when confined", target: "channel:C999", confine: true },
    { name: "delivers its own conversation when confined", target: "channel:C123", confine: true },
  ])("group turn send $name", async ({ target, confine }) => {
    const sendText = registerSlackTextPlugin();
    const send = runMessageAction({
      cfg: {
        ...slackConfig,
        tools: { message: { crossContext: confine ? { confineChatTypes: ["group"] } : {} } },
      },
      action: "send",
      params: { channel: "slack", target, message: "group turn probe" },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "channel:C123",
        currentChatType: "group",
        skipCrossContextDecoration: true,
      },
      dryRun: false,
    });
    if (confine && target === "channel:C999") {
      await expect(send).rejects.toMatchObject({
        message: expect.stringContaining("confineChatTypes keeps group turns"),
        reasonCode: "message_cross_context_denied",
        policyRef: "message-cross-context:target",
      });
      expect(sendText).not.toHaveBeenCalled();
      return;
    }
    await expect(send).resolves.toMatchObject({ kind: "send", channel: "slack", to: target });
    expect(mockFirstRecordArg(sendText, "send text")).toMatchObject({
      to: target,
      text: "group turn probe",
    });
  });

  it.each<{
    name: string;
    action?: ChannelMessageActionName;
    params: Record<string, unknown>;
    denied?: boolean;
    conflict?: boolean;
    boundToChat?: boolean;
  }>([
    { name: "the chat id with the current topic id", params: { threadId: "42" } },
    { name: "the chat id inheriting the current topic", params: {} },
    { name: "the current topic target", params: { target: "-1001234567890:topic:42" } },
    { name: "the chat id with another topic id", params: { threadId: "99" }, denied: true },
    { name: "another topic target", params: { target: "-1001234567890:topic:99" }, denied: true },
    { name: "the top-level chat", params: { topLevel: true }, denied: true },
    // Delivery lets an explicit thread id outrank the topic encoded in the target.
    {
      name: "the current topic target with another topic id",
      params: { target: "-1001234567890:topic:42", threadId: "99" },
      denied: true,
    },
    {
      name: "another topic target with the current topic id",
      params: { target: "-1001234567890:topic:99", threadId: "42" },
    },
    {
      name: "the current topic target with another messageThreadId",
      params: { target: "-1001234567890:topic:42", messageThreadId: "99" },
      denied: true,
    },
    {
      name: "the current topic target with another message_thread_id",
      params: { target: "-1001234567890:topic:42", message_thread_id: "99" },
      denied: true,
    },
    {
      name: "the current topic target with another numeric threadId",
      params: { target: "-1001234567890:topic:42", threadId: 99 },
      denied: true,
    },
    // Sends and polls are delivered into the inherited topic. Telegram creates a topic in the
    // base chat and edits the topic its thread id names.
    {
      name: "a poll to the chat id inheriting the current topic",
      action: "poll",
      params: { pollQuestion: "Lunch?", pollOption: ["yes", "no"] },
    },
    {
      name: "a new topic in the chat id",
      action: "topic-create",
      params: { name: "New topic" },
      denied: true,
    },
    {
      name: "a new topic in the chat id with the current topic id",
      action: "topic-create",
      params: { name: "New topic", threadId: "42" },
      denied: true,
    },
    // Naming the current topic does not move a new topic out of the base chat.
    {
      name: "a new topic through the current topic target",
      action: "topic-create",
      params: { target: "-1001234567890:topic:42", name: "New topic" },
      denied: true,
    },
    {
      name: "a new topic through the current topic target and id",
      action: "topic-create",
      params: { target: "-1001234567890:topic:42", threadId: "42", name: "New topic" },
      denied: true,
    },
    {
      name: "a new topic in the chat its turn is bound to",
      action: "topic-create",
      params: { name: "New topic" },
      boundToChat: true,
    },
    {
      name: "a new topic through another topic target of the chat its turn is bound to",
      action: "topic-create",
      params: { target: "-1001234567890:topic:99", name: "New topic" },
      boundToChat: true,
      denied: true,
    },
    {
      name: "a rename of the current topic through the chat id",
      action: "topic-edit",
      params: { name: "Renamed", threadId: "42" },
      denied: true,
    },
    {
      name: "a rename of the current topic",
      action: "topic-edit",
      params: { target: "-1001234567890:topic:42", threadId: "42", name: "Renamed" },
    },
    {
      name: "a rename of another topic through the current topic target",
      action: "topic-edit",
      params: { target: "-1001234567890:topic:42", threadId: "99", name: "Renamed" },
      denied: true,
    },
    // Telegram reads chatId, chat_id and channel_id ahead of the target, so they must agree.
    {
      name: "a rename through the current topic target and another chatId",
      action: "topic-edit",
      params: { target: "-1001234567890:topic:42", threadId: "42", chatId: "-1009999999999" },
      conflict: true,
    },
    {
      name: "a rename through the current topic target and another channel_id",
      action: "topic-edit",
      params: { target: "-1001234567890:topic:42", threadId: "42", channel_id: "-1009999999999" },
      conflict: true,
    },
    {
      name: "a rename through another chatId alone",
      action: "topic-edit",
      params: { target: undefined, threadId: "42", chatId: "-1009999999999" },
      denied: true,
    },
    {
      name: "a rename through the current topic target and the same chatId",
      action: "topic-edit",
      params: {
        target: "-1001234567890:topic:42",
        threadId: "42",
        chatId: "-1001234567890:topic:42",
      },
    },
    {
      name: "a new topic through another chatId alone from a turn bound to the chat",
      action: "topic-create",
      params: { target: undefined, chatId: "-1009999999999", name: "New topic" },
      boundToChat: true,
      denied: true,
    },
    {
      name: "a new topic through the chatId of the chat its turn is bound to",
      action: "topic-create",
      params: { target: undefined, chatId: "-1001234567890", name: "New topic" },
      boundToChat: true,
    },
  ])("judges a restricted Telegram turn's request for $name", async (scenario) => {
    const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
      pluginId: "telegram",
      artifactBasename: "api.ts",
    });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
    );
    // Both the chat-type confinement and the existing same-provider switch share this check.
    const outcomes: string[] = [];
    for (const crossContext of [
      { confineChatTypes: ["group" as const] },
      { allowWithinProvider: false },
    ]) {
      const run = runMessageAction({
        cfg: {
          channels: { telegram: { botToken: "123:test" } },
          tools: { message: { crossContext } },
        },
        action: scenario.action ?? "send",
        params: {
          channel: "telegram",
          target: "-1001234567890",
          message: "topic probe",
          ...scenario.params,
        },
        toolContext: {
          currentChannelProvider: "telegram",
          // Every other row is bound to topic 42 of the same chat.
          ...(scenario.boundToChat
            ? { currentChannelId: "telegram:-1001234567890" }
            : { currentChannelId: "telegram:-1001234567890:topic:42", currentThreadTs: "42" }),
          currentChatType: "group",
        },
        dryRun: true,
      });
      outcomes.push(
        await run.then(
          () => "allowed",
          (error: unknown) =>
            error instanceof MessageActionDeniedError ? error.reasonCode : String(error),
        ),
      );
    }
    const expected = scenario.conflict
      ? `Error: Action ${scenario.action} received conflicting target and delivery alias values.`
      : scenario.denied
        ? "message_cross_context_denied"
        : "allowed";
    expect(outcomes).toEqual([expected, expected]);
  });

  it("accepts Telegram numeric forum topic targets through plugin-owned grammar", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn(),
            },
            messaging: {
              normalizeTarget: (raw) =>
                raw === "-1001234567890:topic:42" ? "telegram:-1001234567890:topic:42" : undefined,
              targetResolver: {
                looksLikeId: (raw) => raw === "-1001234567890:topic:42",
              },
            },
          }),
        },
      ]),
    );

    const result = await runMessageAction({
      cfg: {
        channels: {
          telegram: {
            botToken: "123:test",
          },
        },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "telegram",
        target: "-1001234567890:topic:42",
        message: "topic hello",
      },
      dryRun: true,
    });

    if (result.kind !== "send") {
      throw new Error(`Expected send result, got ${result.kind}`);
    }
    const payload = result.payload as { dryRun?: boolean; to?: string };
    expect(result.to).toBe("telegram:-1001234567890:topic:42");
    expect(payload.to).toBe("telegram:-1001234567890:topic:42");
    expect(payload.dryRun).toBe(true);
  });

  it("uses best-effort delivery for implicit message-tool-only source replies", async () => {
    const sendText = registerSlackTextPlugin();

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        message: "visible source reply",
        bestEffort: false,
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "channel:C123",
      },
      sessionKey: "agent:main:slack:channel:C123",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(sendText).toHaveBeenCalledOnce();
  });

  it.each(["channel:agent:main:main"])(
    "rejects implicit delivery to internal session %s before sending",
    async (currentChannelId) => {
      const sendText = registerSlackTextPlugin();

      await expect(
        runMessageAction({
          cfg: slackConfig,
          action: "send",
          params: {
            channel: "slack",
            message: "do not deliver to a session key",
          },
          toolContext: {
            currentChannelProvider: "slack",
            currentChannelId,
          },
          sessionKey: "agent:main:subagent:worker",
          dryRun: false,
        }),
      ).rejects.toThrow(/requires a target/i);

      expect(sendText).not.toHaveBeenCalled();
    },
  );

  it("delivers to a real current conversation instead of an internal session channel", async () => {
    const sendText = registerSlackTextPlugin();

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        message: "deliver to the actual conversation",
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "agent:main:subagent:worker",
        currentMessagingTarget: "channel:C123",
      },
      sessionKey: "agent:main:subagent:worker",
      dryRun: false,
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "slack",
      to: "channel:C123",
    });
    expect(mockFirstRecordArg(sendText, "send text")).toMatchObject({
      to: "channel:C123",
      text: "deliver to the actual conversation",
    });
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("preserves required delivery when message-tool-only sends target another conversation", async () => {
    const sendText = registerSlackTextPlugin();

    await expect(
      runMessageAction({
        cfg: slackConfig,
        action: "send",
        params: {
          target: "channel:C999",
          message: "explicit durable send",
          bestEffort: false,
        },
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C123",
        },
        sessionKey: "agent:main:slack:channel:C123",
        sourceReplyDeliveryMode: "message_tool_only",
        dryRun: false,
      }),
    ).rejects.toThrow("missing reconcileUnknownSend");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("preserves required delivery when message-tool-only sends to another explicit channel", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "telegram",
      messageId: "m1",
      chatId: "C999",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: {
              deliveryMode: "direct",
              sendText,
            },
          }),
        },
      ]),
    );

    await expect(
      runMessageAction({
        cfg: {
          channels: {
            telegram: {
              enabled: true,
            },
          },
          tools: {
            message: {
              crossContext: {
                allowAcrossProviders: true,
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "telegram",
          message: "explicit channel-only durable send",
          bestEffort: false,
        },
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C123",
        },
        sessionKey: "agent:main:slack:channel:C123",
        sourceReplyDeliveryMode: "message_tool_only",
        dryRun: false,
      }),
    ).rejects.toThrow("missing reconcileUnknownSend");
    expect(sendText).not.toHaveBeenCalled();
  });
});
