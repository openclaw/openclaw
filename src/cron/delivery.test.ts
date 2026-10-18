// Cron delivery tests cover delivery execution and status recording.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveCronDeliveryPlan, resolveFailureDestination } from "./delivery-plan.js";
import { makeCronJob } from "./delivery.test-helpers.js";

function createPrefixOnlyChannelPlugin(
  id: string,
  targetPrefixes?: readonly string[],
  aliases?: readonly string[],
): ChannelPlugin {
  const plugin = createChannelTestPluginBase({ id });
  return {
    ...plugin,
    ...(aliases ? { meta: { ...plugin.meta, aliases: [...aliases] } } : {}),
    messaging: targetPrefixes ? { targetPrefixes } : {},
  };
}

function setCronDeliveryTestRegistry(
  plugins: Array<{ pluginId: string; plugin: ChannelPlugin }>,
): void {
  setActivePluginRegistry(
    createTestRegistry(
      plugins.map((entry) => ({
        ...entry,
        source: `test:${entry.pluginId}`,
      })),
    ),
  );
}

describe("resolveCronDeliveryPlan", () => {
  beforeEach(() => {
    setCronDeliveryTestRegistry([
      {
        pluginId: "telegram",
        plugin: createPrefixOnlyChannelPlugin("telegram", ["telegram", "tg"]),
      },
      { pluginId: "slack", plugin: createPrefixOnlyChannelPlugin("slack", ["slack"]) },
      {
        pluginId: "googlechat",
        plugin: createPrefixOnlyChannelPlugin(
          "googlechat",
          ["googlechat", "gchat", "google-chat"],
          ["gchat", "google-chat"],
        ),
      },
    ]);
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("rejects an unrepaired primary route while retaining an explicit failure destination", () => {
    const job = makeCronJob({
      delivery: { mode: "announce", channel: "telegram", to: "123" },
    });
    Reflect.deleteProperty(job.delivery!, "mode");
    expect(() => resolveCronDeliveryPlan(job)).toThrow("openclaw doctor --fix");
    expect(resolveFailureDestination(job, { channel: "telegram", to: "123" })).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "123",
      accountId: undefined,
    });
  });

  it("resolves webhook mode without channel routing", () => {
    const plan = resolveCronDeliveryPlan({
      delivery: { mode: "webhook", to: "https://example.invalid/cron" },
    });
    expect(plan.mode).toBe("webhook");
    expect(plan.requested).toBe(false);
    expect(plan.channel).toBeUndefined();
    expect(plan.to).toBe("https://example.invalid/cron");
  });

  it("uses Synology Chat provider prefixes with underscores and short spelling", () => {
    setCronDeliveryTestRegistry([
      {
        pluginId: "synology-chat",
        plugin: createPrefixOnlyChannelPlugin("synology-chat", [
          "synology-chat",
          "synology_chat",
          "synology",
        ]),
      },
    ]);

    for (const to of ["synology-chat:123", "synology_chat:123", "synology:123"]) {
      const plan = resolveCronDeliveryPlan({
        delivery: {
          mode: "announce",
          channel: "last",
          to,
        },
      });
      expect(plan.mode).toBe("announce");
      expect(plan.channel).toBe("synology-chat");
      expect(plan.to).toBe(to);
    }
  });
});

describe("resolveFailureDestination", () => {
  beforeEach(() => {
    setCronDeliveryTestRegistry([
      {
        pluginId: "telegram",
        plugin: createPrefixOnlyChannelPlugin("telegram", ["telegram", "tg"]),
      },
      { pluginId: "slack", plugin: createPrefixOnlyChannelPlugin("slack", ["slack"]) },
      {
        pluginId: "googlechat",
        plugin: createPrefixOnlyChannelPlugin(
          "googlechat",
          ["googlechat", "gchat", "google-chat"],
          ["gchat", "google-chat"],
        ),
      },
      {
        pluginId: "msteams",
        plugin: createPrefixOnlyChannelPlugin("msteams", ["msteams", "teams"], ["teams"]),
      },
    ]);
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it.each([["msteams", "teams", "msteams", "job alert"]])(
    "preserves %s failure routing from %s through %s %s",
    (channelId, globalChannel, channel, override) => {
      expect(
        resolveFailureDestination(
          {
            delivery: {
              mode: "none",
              ...(override === "failure destination" ? { failureDestination: { channel } } : {}),
            },
          },
          {
            channel: globalChannel,
            to: `${channelId}:alerts`,
            accountId: `${channelId}-bot`,
            mode: "announce",
          },
          override === "job alert" ? { channel } : undefined,
        ),
      ).toEqual({
        mode: "announce",
        channel: channelId,
        to: `${channelId}:alerts`,
        accountId: `${channelId}-bot`,
      });
    },
  );

  it("does not reuse inherited ownership for a different provider's channel alias", () => {
    expect(
      resolveFailureDestination(
        {
          delivery: { mode: "none", failureDestination: { channel: "teams" } },
        },
        {
          channel: "gchat",
          to: "googlechat:alerts",
          accountId: "googlechat-bot",
          mode: "announce",
        },
      ),
    ).toEqual({
      mode: "announce",
      channel: "msteams",
      to: undefined,
      accountId: undefined,
    });
  });

  it("does not reuse a channel-specific recipient or account for the last failure channel", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "none",
          failureDestination: { channel: "last" },
        },
      },
      {
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
        mode: "announce",
      },
    );

    expect(plan).toEqual({
      mode: "announce",
      channel: "last",
      to: undefined,
      accountId: undefined,
    });
  });

  it("clears an inherited global webhook URL when a channel-only override implies announce (#102235)", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "none",
          failureDestination: { channel: "slack" },
        },
      },
      { mode: "webhook", to: "https://hook.example/cron" },
    );
    expect(plan).toEqual({
      mode: "announce",
      channel: "slack",
      to: undefined,
      accountId: undefined,
    });
  });

  it.each([
    {
      name: "webhook mode without a URL",
      failureDestination: { mode: "webhook" as const },
      globalConfig: undefined,
      expected: null,
    },
  ])("resolves $name", ({ failureDestination, globalConfig, expected }) => {
    expect(
      resolveFailureDestination({ delivery: { mode: "none", failureDestination } }, globalConfig),
    ).toEqual(expected);
  });

  it("returns null when failure destination matches primary delivery target", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          accountId: "bot-a",
          failureDestination: {
            mode: "announce",
            channel: "telegram",
            to: "111",
            accountId: "bot-a",
          },
        },
      },
      undefined,
    );
    expect(plan).toBeNull();
  });

  it("returns null when provider-prefixed failure destination matches a provider-prefixed primary target", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "announce",
          channel: "last",
          to: "telegram:123",
          failureDestination: {
            mode: "announce",
            to: "telegram:123",
          },
        },
      },
      undefined,
    );
    expect(plan).toBeNull();
  });

  it("returns null when webhook failure destination matches the primary webhook target", () => {
    const plan = resolveFailureDestination(
      makeCronJob({
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "tick" },
        delivery: {
          mode: "webhook",
          to: "https://example.invalid/cron",
          failureDestination: {
            mode: "webhook",
            to: "https://example.invalid/cron",
          },
        },
      }),
      undefined,
    );
    expect(plan).toBeNull();
  });

  it("does not reuse inherited announce recipient when switching failure destination to webhook", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          failureDestination: {
            mode: "webhook",
          },
        },
      },
      {
        channel: "signal",
        to: "group-abc",
        mode: "announce",
      },
    );
    expect(plan).toBeNull();
  });

  it("keeps inherited announce targets when a job clears only failure destination mode", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          failureDestination: {
            mode: undefined,
          },
        },
      },
      {
        channel: "signal",
        to: "group-abc",
        accountId: "global-account",
        mode: "announce",
      },
    );
    expect(plan).toEqual({
      mode: "announce",
      channel: "signal",
      to: "group-abc",
      accountId: "global-account",
    });
  });

  it("does not inherit a foreign global account for a prefixed failure destination", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          failureDestination: {
            mode: "announce",
            to: "slack:U123",
          },
        },
      },
      {
        mode: "announce",
        channel: "telegram",
        to: "telegram:alerts",
        accountId: "telegram-bot",
      },
    );

    expect(plan).toEqual({
      mode: "announce",
      channel: "slack",
      to: "slack:U123",
      accountId: undefined,
    });
  });
});
