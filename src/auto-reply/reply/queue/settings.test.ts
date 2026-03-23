import { afterEach, describe, expect, it } from "vitest";
import { discordPlugin } from "../../../../extensions/discord/src/channel.js";
import { slackPlugin } from "../../../../extensions/slack/src/channel.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { createOutboundTestPlugin } from "../../../test-utils/channel-plugins.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import { resolveQueueSettings } from "./settings.js";

describe("resolveQueueSettings", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("uses the Slack plugin default queue mode when config is unset", () => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "slack", source: "test", plugin: slackPlugin },
        { pluginId: "discord", source: "test", plugin: discordPlugin },
      ]),
    );

    expect(resolveQueueSettings({ cfg: {}, channel: "slack" }).mode).toBe("followup");
    expect(resolveQueueSettings({ cfg: {}, channel: "discord" }).mode).toBe("collect");
  });

  it("lets explicit config override the Slack plugin default", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackPlugin }]),
    );

    expect(
      resolveQueueSettings({
        cfg: { messages: { queue: { byChannel: { slack: "collect" } } } },
        channel: "slack",
      }).mode,
    ).toBe("collect");
  });

  it("falls back to collect when the plugin does not declare a queue-mode default", () => {
    const slackWithoutQueueDefault = {
      ...slackPlugin,
      defaults: undefined,
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackWithoutQueueDefault }]),
    );

    expect(resolveQueueSettings({ cfg: {}, channel: "slack" }).mode).toBe("collect");
  });

  it("ignores invalid plugin queue-mode defaults", () => {
    const testPlugin = {
      ...createOutboundTestPlugin({
        id: "slack",
        outbound: {
          deliveryMode: "direct",
          sendText: async () => ({ channel: "slack", messageId: "slack-msg" }),
        },
        label: "Slack",
      }),
      defaults: {
        queue: {
          mode: "bogus" as unknown as "collect",
        },
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", source: "test", plugin: testPlugin }]),
    );

    expect(resolveQueueSettings({ cfg: {}, channel: "slack" }).mode).toBe("collect");
  });

  it("falls back to collect when channel is missing or empty", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackPlugin }]),
    );

    expect(resolveQueueSettings({ cfg: {}, channel: undefined }).mode).toBe("collect");
    expect(resolveQueueSettings({ cfg: {}, channel: "" }).mode).toBe("collect");
  });
});
