import { Container, Separator, TextDisplay } from "@buape/carbon";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { getChannelMessageAdapter } from "./channel-adapters.js";

class TestDiscordUiContainer extends Container {}

const discordCrossContextPlugin: Pick<
  ChannelPlugin,
  "id" | "meta" | "capabilities" | "config" | "messaging"
> = {
  ...createChannelTestPluginBase({ id: "discord" }),
  messaging: {
    buildCrossContextComponents: ({ originLabel, message, cfg, accountId }) => {
      const trimmed = message.trim();
      const components: Array<TextDisplay | Separator> = [];
      if (trimmed) {
        components.push(new TextDisplay(message));
        components.push(new Separator({ divider: true, spacing: "small" }));
      }
      components.push(new TextDisplay(`*From ${originLabel}*`));
      void cfg;
      void accountId;
      return [new TestDiscordUiContainer(components)];
    },
  },
};

describe("getChannelMessageAdapter", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "discord", plugin: discordCrossContextPlugin, source: "test" },
      ]),
    );
  });

  it("returns the default adapter for non-discord channels", () => {
    expect(getChannelMessageAdapter("telegram")).toEqual({
      supportsComponentsV2: false,
    });
  });

  it("returns the discord adapter with a cross-context component builder", () => {
    const adapter = getChannelMessageAdapter("discord");

    expect(adapter.supportsComponentsV2).toBe(true);
    expect(adapter.buildCrossContextComponents).toBeTypeOf("function");

    const components = adapter.buildCrossContextComponents?.({
      originLabel: "Telegram",
      message: "Hello from chat",
      cfg: {} as never,
      accountId: "primary",
    });
    const container = components?.[0] as TestDiscordUiContainer | undefined;

    expect(components).toHaveLength(1);
    expect(container).toBeInstanceOf(TestDiscordUiContainer);
    expect(container?.components).toEqual([
      expect.any(TextDisplay),
      expect.any(Separator),
      expect.any(TextDisplay),
    ]);
  });

  it("omits the message body block when the cross-context message is blank", () => {
    const adapter = getChannelMessageAdapter("discord");
    const components = adapter.buildCrossContextComponents?.({
      originLabel: "Signal",
      message: "   ",
      cfg: {} as never,
    });
    const container = components?.[0] as TestDiscordUiContainer | undefined;

    expect(components).toHaveLength(1);
    expect(container?.components).toEqual([expect.any(TextDisplay)]);
  });
});
