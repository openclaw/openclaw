import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelMessageReplyPipeline as createChannelReplyPipeline } from "./channel-outbound.js";

describe("createChannelReplyPipeline", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("resolves the live response prefix from selected-model context", () => {
    const pipeline = createChannelReplyPipeline({
      cfg: { channels: { mattermost: { responsePrefix: "[{model} | {thinkingLevel}]" } } },
      agentId: "main",
      channel: "mattermost",
    });

    pipeline.onModelSelected({
      provider: "openai",
      model: "gpt-5.5",
      thinkLevel: "high",
    });

    expect(pipeline.resolveResponsePrefix?.()).toBe("[gpt-5.5 | high]");
  });

  it.each([
    { name: "rewrites", veto: false },
    { name: "vetoes", veto: true },
  ])("preserves the loaded plugin receiver when it $name a reply", ({ veto }) => {
    const messaging = {
      transformReplyPayload: vi.fn(function (
        this: unknown,
        { payload }: { payload: { text?: string } },
      ) {
        expect(this).toBe(messaging);
        return veto
          ? null
          : payload.text
            ? { ...payload, text: `${payload.text} transformed` }
            : payload;
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

    expect(pipeline.transformReplyPayload?.({ text: "reply" })).toEqual(
      veto ? null : { text: "reply transformed" },
    );
    expect(messaging.transformReplyPayload).toHaveBeenCalledWith({
      payload: { text: "reply" },
      cfg: {},
      accountId: "acct",
    });
  });
});
