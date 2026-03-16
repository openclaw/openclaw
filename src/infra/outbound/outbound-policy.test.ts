import { beforeEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "../../../extensions/discord/src/channel.js";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

let importScope = 0;
let applyCrossContextDecoration: (typeof import("./outbound-policy.js"))["applyCrossContextDecoration"];
let buildCrossContextDecoration: (typeof import("./outbound-policy.js"))["buildCrossContextDecoration"];
let enforceCrossContextPolicy: (typeof import("./outbound-policy.js"))["enforceCrossContextPolicy"];
let shouldApplyCrossContextMarker: (typeof import("./outbound-policy.js"))["shouldApplyCrossContextMarker"];

beforeEach(async () => {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", plugin: discordPlugin, source: "test" }]),
  );
  vi.resetModules();
  const scope = `outbound-policy-${importScope++}`;
  ({
    applyCrossContextDecoration,
    buildCrossContextDecoration,
    enforceCrossContextPolicy,
    shouldApplyCrossContextMarker,
  } = await importFreshModule<typeof import("./outbound-policy.js")>(
    import.meta.url,
    `./outbound-policy.js?scope=${scope}`,
  ));
});

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
