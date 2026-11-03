// Covers core message-action send fallback, TTS application, and durable send
// policy after plugin preparation is absent.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { mockFirstRecordArg } from "../../test-utils/mock-call-assertions.js";
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

  it.each([
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
  ])("judges a restricted Telegram topic turn sending to $name by its topic", async (scenario) => {
    const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
      pluginId: "telegram",
      artifactBasename: "api.ts",
    });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
    );
    // Both the chat-type confinement and the existing same-provider switch share this check.
    for (const crossContext of [
      { confineChatTypes: ["group" as const] },
      { allowWithinProvider: false },
    ]) {
      const send = runMessageAction({
        cfg: {
          channels: { telegram: { botToken: "123:test" } },
          tools: { message: { crossContext } },
        },
        action: "send",
        params: {
          channel: "telegram",
          target: "-1001234567890",
          message: "topic probe",
          ...scenario.params,
        },
        toolContext: {
          currentChannelProvider: "telegram",
          currentChannelId: "telegram:-1001234567890:topic:42",
          currentThreadTs: "42",
          currentChatType: "group",
        },
        dryRun: true,
      });
      await (scenario.denied
        ? expect(send).rejects.toMatchObject({ reasonCode: "message_cross_context_denied" })
        : expect(send).resolves.toMatchObject({ kind: "send", dryRun: true }));
    }
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
