/**
 * Tests channel reply transforms through the loaded plugin receiver.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelMessageReplyPipeline as createChannelReplyPipeline } from "./channel-outbound.js";

describe("createChannelReplyPipeline", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("preserves the loaded plugin receiver when it vetoes a reply", () => {
    const messaging = {
      transformReplyPayload: vi.fn(function (this: unknown) {
        expect(this).toBe(messaging);
        return null;
      }),
    };
    const channelPlugin = {
      id: "demo-channel",
      meta: {},
      messaging,
    } as unknown as ChannelPlugin;
    setActivePluginRegistry({
      ...createEmptyPluginRegistry(),
      channels: [
        {
          pluginId: "demo",
          pluginName: "Demo",
          plugin: channelPlugin,
          source: "test",
        },
      ],
    });

    const pipeline = createChannelReplyPipeline({
      cfg: {},
      agentId: "main",
      channel: "demo-channel",
      accountId: "acct",
    });

    expect(pipeline.transformReplyPayload?.({ text: "reply" })).toBeNull();
    expect(messaging.transformReplyPayload).toHaveBeenCalledWith({
      payload: { text: "reply" },
      cfg: {},
      accountId: "acct",
    });
  });
});
