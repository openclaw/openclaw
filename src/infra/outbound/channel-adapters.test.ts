import { Container, Separator, TextDisplay } from "@buape/carbon";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
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

  it.each([
    {
      message: "Hello from chat",
      originLabel: "Telegram",
      accountId: "primary",
      expectedComponents: [expect.any(TextDisplay), expect.any(Separator), expect.any(TextDisplay)],
    },
    {
      message: "   ",
      originLabel: "Signal",
      expectedComponents: [expect.any(TextDisplay)],
    },
  ])(
    "builds cross-context components for %j",
    ({ message, originLabel, accountId, expectedComponents }) => {
      const adapter = getChannelMessageAdapter("discord");
      const components = adapter.buildCrossContextComponents?.({
        originLabel,
        message,
        cfg: {} as never,
        ...(accountId ? { accountId } : {}),
      });
      const container = components?.[0] as TestDiscordUiContainer | undefined;

      expect(components).toHaveLength(1);
      expect(container?.components).toEqual(expectedComponents);
    },
  );

  describe("useComponentsV2 config", () => {
    it("disables components v2 when useComponentsV2 is false at base channel level", () => {
      const cfg: OpenClawConfig = {
        channels: { discord: { useComponentsV2: false } },
      };
      const adapter = getChannelMessageAdapter("discord", cfg);
      expect(adapter.supportsComponentsV2).toBe(false);
      expect(adapter.buildCrossContextComponents).toBeUndefined();
    });

    it("keeps components v2 enabled when useComponentsV2 is true at base channel level", () => {
      const cfg: OpenClawConfig = {
        channels: { discord: { useComponentsV2: true } },
      };
      const adapter = getChannelMessageAdapter("discord", cfg);
      expect(adapter.supportsComponentsV2).toBe(true);
      expect(adapter.buildCrossContextComponents).toBeTypeOf("function");
    });

    it("defaults to components v2 enabled when useComponentsV2 is omitted", () => {
      const cfg: OpenClawConfig = { channels: { discord: {} } };
      const adapter = getChannelMessageAdapter("discord", cfg);
      expect(adapter.supportsComponentsV2).toBe(true);
    });

    it("account-level useComponentsV2: false overrides base-level default", () => {
      const cfg: OpenClawConfig = {
        channels: {
          discord: {
            accounts: { mybot: { useComponentsV2: false } },
          },
        },
      };
      const adapter = getChannelMessageAdapter("discord", cfg, "mybot");
      expect(adapter.supportsComponentsV2).toBe(false);
      expect(adapter.buildCrossContextComponents).toBeUndefined();
    });

    it("account-level useComponentsV2: true overrides base-level false", () => {
      const cfg: OpenClawConfig = {
        channels: {
          discord: {
            useComponentsV2: false,
            accounts: { mybot: { useComponentsV2: true } },
          },
        },
      };
      const adapter = getChannelMessageAdapter("discord", cfg, "mybot");
      expect(adapter.supportsComponentsV2).toBe(true);
      expect(adapter.buildCrossContextComponents).toBeTypeOf("function");
    });

    it("falls back to base-level config when account has no useComponentsV2 override", () => {
      const cfg: OpenClawConfig = {
        channels: {
          discord: {
            useComponentsV2: false,
            accounts: { mybot: {} },
          },
        },
      };
      const adapter = getChannelMessageAdapter("discord", cfg, "mybot");
      expect(adapter.supportsComponentsV2).toBe(false);
    });

    it("does not affect channels without a plugin buildCrossContextComponents", () => {
      const cfg: OpenClawConfig = {
        channels: { discord: { useComponentsV2: false } },
      };
      // Telegram plugin has no buildCrossContextComponents, so always returns default
      const adapter = getChannelMessageAdapter("telegram", cfg);
      expect(adapter.supportsComponentsV2).toBe(false);
    });
  });
});
