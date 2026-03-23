import { Container, Separator, TextDisplay } from "@buape/carbon";
import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  applyCrossContextDecoration,
  buildCrossContextDecoration,
  enforceCrossContextPolicy,
  shouldApplyCrossContextMarker,
} from "./outbound-policy.js";

class TestDiscordUiContainer extends Container {}

const mocks = vi.hoisted(() => ({
  getChannelMessageAdapter: vi.fn((channel: string) =>
    channel === "discord"
      ? {
          supportsComponentsV2: true,
          buildCrossContextComponents: ({
            originLabel,
            message,
          }: {
            originLabel: string;
            message: string;
          }) => {
            const trimmed = message.trim();
            const components: Array<TextDisplay | Separator> = [];
            if (trimmed) {
              components.push(new TextDisplay(message));
              components.push(new Separator({ divider: true, spacing: "small" }));
            }
            components.push(new TextDisplay(`*From ${originLabel}*`));
            return [new TestDiscordUiContainer(components)];
          },
        }
      : { supportsComponentsV2: false },
  ),
  normalizeTargetForProvider: vi.fn((channel: string, raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    if (channel === "slack") {
      return trimmed.replace(/^#/, "");
    }
    return trimmed;
  }),
  lookupDirectoryDisplay: vi.fn(async ({ targetId }: { targetId: string }) =>
    targetId.replace(/^#/, ""),
  ),
  formatTargetDisplay: vi.fn(
    ({ target, display }: { target: string; display?: string }) => display ?? target,
  ),
}));

vi.mock("./channel-adapters.js", () => ({
  getChannelMessageAdapter: mocks.getChannelMessageAdapter,
}));

vi.mock("./target-normalization.js", () => ({
  normalizeTargetForProvider: mocks.normalizeTargetForProvider,
}));

vi.mock("./target-resolver.js", () => ({
  formatTargetDisplay: mocks.formatTargetDisplay,
  lookupDirectoryDisplay: mocks.lookupDirectoryDisplay,
}));

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
    vi.clearAllMocks();
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
