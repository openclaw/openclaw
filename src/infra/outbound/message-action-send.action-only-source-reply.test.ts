// Regression for #94597: message_tool_only must reuse the current plugin
// conversation target instead of dropping the send on the private sink.
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

const actionOnlyId = "actiononly";
const otherId = "otherchat";
const currentTarget = "group:room-1";

function actionOnlyPlugin(params: {
  handleAction: NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>;
  supportsSend?: boolean;
}): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: actionOnlyId,
      capabilities: { chatTypes: ["direct", "group"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
    }),
    messaging: {
      targetResolver: {
        looksLikeId: () => true,
      },
    },
    actions: {
      describeMessageTool: () => ({ actions: params.supportsSend === false ? [] : ["send"] }),
      supportsAction: ({ action }) => params.supportsSend !== false && action === "send",
      handleAction: params.handleAction,
    },
  };
}

function otherOutboundPlugin(
  sendText: NonNullable<NonNullable<ChannelPlugin["outbound"]>["sendText"]>,
): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: otherId,
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
    }),
    messaging: {
      targetResolver: {
        looksLikeId: () => true,
      },
    },
    outbound: {
      deliveryMode: "direct",
      sendText,
    },
  };
}

function registerPlugins(plugin: ChannelPlugin, other: ChannelPlugin) {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: actionOnlyId, plugin, source: "test", origin: "config" },
      { pluginId: otherId, plugin: other, source: "test", origin: "config" },
    ]),
  );
}

const enabledConfig = {
  channels: {
    [actionOnlyId]: { enabled: true },
    [otherId]: { enabled: true },
  },
} as OpenClawConfig;

describe("action-only source replies under message_tool_only", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("delivers an implicit send to the current plugin conversation", async () => {
    const handleAction = vi.fn(async () => jsonResult({ ok: true, messageId: "sent-1" }));
    const sendText = vi.fn(async () => ({ channel: otherId, messageId: "other-1" }));
    registerPlugins(actionOnlyPlugin({ handleAction }), otherOutboundPlugin(sendText));

    const result = await runMessageAction({
      cfg: enabledConfig,
      action: "send",
      params: { message: "hello" },
      sessionKey: `agent:main:${actionOnlyId}:group:room-1`,
      sourceReplyDeliveryMode: "message_tool_only",
      defaultAccountId: "default",
      requesterAccountId: "default",
      toolContext: {
        currentChannelProvider: actionOnlyId,
        currentChannelId: currentTarget,
        currentMessageId: "source-message-1",
      },
      dryRun: false,
    });

    expect(sendText).not.toHaveBeenCalled();
    expect(handleAction).toHaveBeenCalledOnce();
    expect(handleAction.mock.calls[0]?.[0]).toMatchObject({
      action: "send",
      channel: actionOnlyId,
      params: expect.objectContaining({
        message: "hello",
        to: currentTarget,
      }),
    });
    expect(result).toMatchObject({
      kind: "send",
      handledBy: "plugin",
      channel: actionOnlyId,
      to: currentTarget,
    });
  });

  it("does not invent a destination when the current plugin conversation has no target", async () => {
    const handleAction = vi.fn(async () => jsonResult({ ok: true }));
    const sendText = vi.fn(async () => ({ channel: otherId, messageId: "other-1" }));
    registerPlugins(actionOnlyPlugin({ handleAction }), otherOutboundPlugin(sendText));

    const result = await runMessageAction({
      cfg: enabledConfig,
      action: "send",
      params: { message: "hello" },
      sessionKey: `agent:main:${actionOnlyId}:main`,
      sourceReplyDeliveryMode: "message_tool_only",
      toolContext: {
        currentChannelProvider: actionOnlyId,
        currentMessageId: "source-message-1",
      },
      dryRun: false,
    });

    expect(handleAction).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(result).toMatchObject({ handledBy: "internal-source", to: "current-run" });
  });

  it("keeps a declined send action on the private sink", async () => {
    const handleAction = vi.fn(async () => jsonResult({ ok: true }));
    const sendText = vi.fn(async () => ({ channel: otherId, messageId: "other-1" }));
    registerPlugins(
      actionOnlyPlugin({ handleAction, supportsSend: false }),
      otherOutboundPlugin(sendText),
    );

    const result = await runMessageAction({
      cfg: enabledConfig,
      action: "send",
      params: { message: "hello" },
      sessionKey: `agent:main:${actionOnlyId}:group:room-1`,
      sourceReplyDeliveryMode: "message_tool_only",
      toolContext: {
        currentChannelProvider: actionOnlyId,
        currentChannelId: currentTarget,
      },
      dryRun: false,
    });

    expect(handleAction).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(result).toMatchObject({ handledBy: "internal-source", to: "current-run" });
  });

  it("does not fall back to another configured channel when the current plugin is disabled", async () => {
    const handleAction = vi.fn(async () => jsonResult({ ok: true }));
    const sendText = vi.fn(async () => ({ channel: otherId, messageId: "other-1" }));
    registerPlugins(actionOnlyPlugin({ handleAction }), otherOutboundPlugin(sendText));

    const result = await runMessageAction({
      cfg: {
        channels: {
          [actionOnlyId]: { enabled: false },
          [otherId]: { enabled: true },
        },
      } as OpenClawConfig,
      action: "send",
      params: { message: "hello" },
      sessionKey: `agent:main:${actionOnlyId}:group:room-1`,
      sourceReplyDeliveryMode: "message_tool_only",
      toolContext: {
        currentChannelProvider: actionOnlyId,
        currentChannelId: currentTarget,
      },
      dryRun: false,
    });

    expect(handleAction).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(result).toMatchObject({ handledBy: "internal-source", to: "current-run" });
  });

  it("still fails a send that has no current conversation and no explicit target", async () => {
    const handleAction = vi.fn(async () => jsonResult({ ok: true }));
    const sendText = vi.fn(async () => ({ channel: otherId, messageId: "other-1" }));
    registerPlugins(actionOnlyPlugin({ handleAction }), otherOutboundPlugin(sendText));

    await expect(
      runMessageAction({
        cfg: enabledConfig,
        action: "send",
        params: { message: "hello" },
        sessionKey: "agent:main:main",
        sourceReplyDeliveryMode: "message_tool_only",
        dryRun: false,
      }),
    ).rejects.toThrow(/requires a target/i);
    expect(handleAction).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });
});
