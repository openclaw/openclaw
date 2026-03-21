import { Container, Separator, TextDisplay } from "@buape/carbon";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  applyCrossContextDecoration,
  buildCrossContextDecoration,
  enforceCrossContextPolicy,
  shouldApplyCrossContextMarker,
} from "./outbound-policy.js";

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

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

const discordConfig = {
  channels: {
    discord: {},
  },
} as OpenClawConfig;

describe("outbound policy helpers", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "discord", plugin: discordCrossContextPlugin, source: "test" },
      ]),
    );
  });

  it("allows cross-provider sends when enabled", () => {
    const cfg = {
      ...slackConfig,
      tools: {
        message: { crossContext: { allowAcrossProviders: true } },
      },
    } as OpenClawConfig;

    expect(() =>
      enforceCrossContextPolicy({
        cfg,
        channel: "telegram",
        action: "send",
        args: { to: "telegram:@ops" },
        toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
      }),
    ).not.toThrow();
  });

  it("blocks cross-provider sends when not allowed", () => {
    expect(() =>
      enforceCrossContextPolicy({
        cfg: slackConfig,
        channel: "telegram",
        action: "send",
        args: { to: "telegram:@ops" },
        toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
      }),
    ).toThrow(/target provider "telegram" while bound to "slack"/);
  });

  it("blocks same-provider cross-context sends when allowWithinProvider is false", () => {
    const cfg = {
      ...slackConfig,
      tools: {
        message: { crossContext: { allowWithinProvider: false } },
      },
    } as OpenClawConfig;

    expect(() =>
      enforceCrossContextPolicy({
        cfg,
        channel: "slack",
        action: "send",
        args: { to: "C999" },
        toolContext: { currentChannelId: "C123", currentChannelProvider: "slack" },
      }),
    ).toThrow(/target="C999" while bound to "C123"/);
  });

  it("uses components when available and preferred", async () => {
    const decoration = await buildCrossContextDecoration({
      cfg: discordConfig,
      channel: "discord",
      target: "123",
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "discord" },
    });

    expect(decoration).not.toBeNull();
    const applied = applyCrossContextDecoration({
      message: "hello",
      decoration: decoration!,
      preferComponents: true,
    });

    expect(applied.usedComponents).toBe(true);
    expect(applied.componentsBuilder).toBeDefined();
    expect(applied.componentsBuilder?.("hello").length).toBeGreaterThan(0);
    expect(applied.message).toBe("hello");
  });

  it("returns null when decoration is skipped and falls back to text markers", async () => {
    await expect(
      buildCrossContextDecoration({
        cfg: discordConfig,
        channel: "discord",
        target: "123",
        toolContext: {
          currentChannelId: "C12345678",
          currentChannelProvider: "discord",
          skipCrossContextDecoration: true,
        },
      }),
    ).resolves.toBeNull();

    const applied = applyCrossContextDecoration({
      message: "hello",
      decoration: { prefix: "[from ops] ", suffix: " [cc]" },
      preferComponents: true,
    });
    expect(applied).toEqual({
      message: "[from ops] hello [cc]",
      usedComponents: false,
    });
  });

  it("marks only supported cross-context actions", () => {
    expect(shouldApplyCrossContextMarker("send")).toBe(true);
    expect(shouldApplyCrossContextMarker("thread-reply")).toBe(true);
    expect(shouldApplyCrossContextMarker("thread-create")).toBe(false);
  });
});
