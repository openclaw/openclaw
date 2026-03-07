import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { formatGatewayChannelsStatusLines } from "./channels/status.js";

const feishuTestPlugin = {
  ...createChannelTestPluginBase({
    id: "feishu",
    label: "Feishu",
    docsPath: "/channels/feishu",
  }),
} as ChannelPlugin;

describe("channels status output", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "feishu",
          source: "test",
          plugin: feishuTestPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("omits redundant not-configured runtime error text", () => {
    const lines = formatGatewayChannelsStatusLines({
      channelAccounts: {
        feishu: [
          {
            accountId: "default",
            enabled: true,
            configured: false,
            running: false,
            lastError: "not configured",
          },
        ],
      },
    });
    const joined = lines.join("\n");
    expect(joined).toContain("Feishu default: enabled, not configured, stopped");
    expect(joined).not.toContain("error:not configured");
  });
});
