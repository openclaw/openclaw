// Reasoning capability tests cover channel plugin reasoning-lane detection.
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { channelSupportsReasoningPayloads } from "./reasoning-capabilities.js";
import type { ChannelPlugin } from "./types.js";

function createChannelPlugin(id: string, capabilities: ChannelPlugin["capabilities"]): ChannelPlugin {
  return createChannelTestPluginBase({
    id,
    label: id,
    capabilities,
    config: {
      listAccountIds: () => ["default"],
    },
  });
}

describe("channelSupportsReasoningPayloads", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("reads the reasoning-lane capability from channel plugins", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createChannelPlugin("telegram", {
            chatTypes: ["direct"],
            reasoningPayloads: true,
          }),
        },
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: createChannelPlugin("whatsapp", { chatTypes: ["direct"] }),
        },
      ]),
    );
    expect(channelSupportsReasoningPayloads("telegram")).toBe(true);
    // No declared capability → not a reasoning-lane channel.
    expect(channelSupportsReasoningPayloads("whatsapp")).toBe(false);
    // Unregistered channel → false (not undefined-throws).
    expect(channelSupportsReasoningPayloads("slack")).toBe(false);
    expect(channelSupportsReasoningPayloads(undefined)).toBe(false);
  });
});
