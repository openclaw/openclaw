import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  applyCrossContextDecoration,
  buildCrossContextDecoration,
  enforceCrossContextPolicy,
  shouldApplyCrossContextMarker,
} from "./outbound-policy.js";

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

const telegramConfig = {
  channels: {
    telegram: {
      botToken: "telegram-test",
    },
  },
} as OpenClawConfig;

describe("outbound policy helpers", () => {
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

  it("blocks same-provider cross-context sends by default", () => {
    expect(() =>
      enforceCrossContextPolicy({
        cfg: slackConfig,
        channel: "slack",
        action: "send",
        args: { to: "C999" },
        toolContext: { currentChannelId: "C123", currentChannelProvider: "slack" },
      }),
    ).toThrow(/target="C999" while bound to "C123"/);
  });

  it("allows same-provider cross-context sends when allowWithinProvider is true", () => {
    const cfg = {
      ...slackConfig,
      tools: {
        message: { crossContext: { allowWithinProvider: true } },
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
    ).not.toThrow();
  });

  it("allows Telegram explicit current-topic targets by default", () => {
    expect(() =>
      enforceCrossContextPolicy({
        cfg: telegramConfig,
        channel: "telegram",
        action: "send",
        args: { to: "telegram:-100123:topic:42" },
        toolContext: {
          currentChannelId: "telegram:-100123",
          currentChannelProvider: "telegram",
          currentThreadTs: "42",
        },
      }),
    ).not.toThrow();
  });

  it("blocks Telegram explicit different-topic targets by default", () => {
    expect(() =>
      enforceCrossContextPolicy({
        cfg: telegramConfig,
        channel: "telegram",
        action: "send",
        args: { to: "telegram:-100123:topic:99" },
        toolContext: {
          currentChannelId: "telegram:-100123",
          currentChannelProvider: "telegram",
          currentThreadTs: "42",
        },
      }),
    ).toThrow(/Cross-context messaging denied/);
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
