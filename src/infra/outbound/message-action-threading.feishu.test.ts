import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildThreadingToolContext } from "../../auto-reply/reply/agent-runner-utils.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveAndApplyOutboundReplyToId } from "./message-action-threading.js";

const { feishuPlugin } = await loadBundledPluginFacade<{ feishuPlugin: ChannelPlugin }>({
  pluginId: "feishu",
  artifactBasename: "channel-plugin-api.js",
});
const cfg = {
  channels: {
    feishu: { enabled: true, appId: "cli_test", appSecret: "test-secret" },
  },
};

describe("message action Feishu reply anchors", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "feishu", plugin: feishuPlugin, source: "test" }]),
    );
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("does not attach an internal trigger UUID to an outbound message", () => {
    const sessionCtx = {
      Provider: "feishu",
      To: "chat:oc_group_1",
      ChatType: "group",
      MessageSid: "b6a9fb30-6bc6-4ec0-83d1-10bc32e89a2d",
      ReplyToMode: "all" as const,
    };
    const toolContext = buildThreadingToolContext({
      sessionCtx,
      config: cfg,
      hasRepliedRef: { value: false },
    });
    const params: Record<string, unknown> = { to: "chat:oc_group_1", message: "Update." };

    expect(
      resolveAndApplyOutboundReplyToId(params, {
        channel: "feishu",
        toolContext,
        matchesToolContextTarget: feishuPlugin.threading?.matchesToolContextTarget,
      }),
    ).toBeUndefined();
    expect(params).not.toHaveProperty("replyTo");
    expect(sessionCtx.MessageSid).toBe("b6a9fb30-6bc6-4ec0-83d1-10bc32e89a2d");
  });

  it.each([
    { messageId: "om_inbound", explicitReplyTo: undefined, source: "implicit" },
    {
      messageId: "b6a9fb30-6bc6-4ec0-83d1-10bc32e89a2d",
      explicitReplyTo: "om_inbound",
      source: "explicit",
    },
  ] as const)("preserves $source native replies", ({ messageId, explicitReplyTo, source }) => {
    const toolContext = buildThreadingToolContext({
      sessionCtx: {
        Provider: "feishu",
        To: "chat:oc_group_1",
        MessageSid: messageId,
        ReplyToMode: "all",
      },
      config: cfg,
      hasRepliedRef: { value: false },
    });
    const params: Record<string, unknown> = {
      to: "chat:oc_group_1",
      message: "Reply.",
      ...(explicitReplyTo ? { replyTo: explicitReplyTo } : {}),
    };

    expect(
      resolveAndApplyOutboundReplyToId(params, {
        channel: "feishu",
        toolContext,
        matchesToolContextTarget: feishuPlugin.threading?.matchesToolContextTarget,
      }),
    ).toMatchObject({ replyToId: "om_inbound", source });
    expect(params.replyTo).toBe("om_inbound");
  });
});
