import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { CronFailureDestinationConfig } from "../config/types.cron.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveCronDeliveryPlan, resolveFailureDestination } from "./delivery-plan.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import type { CronDelivery } from "./types.js";

function channelPlugin(id: string, targetPrefixes: string[], aliases?: string[]): ChannelPlugin {
  const plugin = createChannelTestPluginBase({ id });
  return {
    ...plugin,
    ...(aliases ? { meta: { ...plugin.meta, aliases } } : {}),
    messaging: { targetPrefixes },
  };
}

function register(plugins: ChannelPlugin[]) {
  setActivePluginRegistry(
    createTestRegistry(
      plugins.map((plugin) => ({ pluginId: plugin.id, plugin, source: `test:${plugin.id}` })),
    ),
  );
}

function failure(
  failureDestination: CronDelivery["failureDestination"],
  globalConfig?: CronFailureDestinationConfig,
  primary: CronDelivery = { mode: "none" },
) {
  return resolveFailureDestination({ delivery: { ...primary, failureDestination } }, globalConfig);
}

function announce(channel: string, to?: string, accountId?: string) {
  return { mode: "announce", channel, to, accountId };
}

const baseChannels = () => [
  channelPlugin("telegram", ["telegram", "tg"]),
  channelPlugin("slack", ["slack"]),
  channelPlugin("googlechat", ["googlechat", "gchat", "google-chat"], ["gchat", "google-chat"]),
];
beforeEach(() => register(baseChannels()));
afterEach(() => resetPluginRuntimeStateForTest());

describe("resolveCronDeliveryPlan", () => {
  it("rejects an unrepaired primary route while retaining an explicit failure destination", () => {
    const job = makeCronJob({ delivery: { mode: "announce", channel: "telegram", to: "123" } });
    Reflect.deleteProperty(job.delivery!, "mode");
    expect(() => resolveCronDeliveryPlan(job)).toThrow("openclaw doctor --fix");
    expect(resolveFailureDestination(job, { channel: "telegram", to: "123" })).toEqual(
      announce("telegram", "123"),
    );
  });

  it("resolves webhook mode without channel routing", () => {
    expect(
      resolveCronDeliveryPlan({
        delivery: { mode: "webhook", to: "https://example.invalid/cron" },
      }),
    ).toMatchObject({
      mode: "webhook",
      requested: false,
      channel: undefined,
      to: "https://example.invalid/cron",
    });
  });

  it("uses Synology Chat provider prefixes with underscores and short spelling", () => {
    register([channelPlugin("synology-chat", ["synology-chat", "synology_chat", "synology"])]);
    for (const to of ["synology-chat:123", "synology_chat:123", "synology:123"]) {
      expect(
        resolveCronDeliveryPlan({ delivery: { mode: "announce", channel: "last", to } }),
      ).toMatchObject({ mode: "announce", channel: "synology-chat", to });
    }
  });
});

describe("resolveFailureDestination", () => {
  beforeEach(() =>
    register([...baseChannels(), channelPlugin("msteams", ["msteams", "teams"], ["teams"])]),
  );
  it("preserves msteams failure routing from its global alias through a job alert", () => {
    expect(
      resolveFailureDestination(
        { delivery: { mode: "none" } },
        { channel: "teams", to: "msteams:alerts", accountId: "msteams-bot", mode: "announce" },
        { channel: "msteams" },
      ),
    ).toEqual(announce("msteams", "msteams:alerts", "msteams-bot"));
  });

  it("does not reuse inherited ownership for a different provider's channel alias", () => {
    expect(
      failure(
        { channel: "teams" },
        {
          channel: "gchat",
          to: "googlechat:alerts",
          accountId: "googlechat-bot",
          mode: "announce",
        },
      ),
    ).toEqual(announce("msteams"));
  });

  it("does not reuse a channel-specific recipient or account for the last failure channel", () => {
    expect(
      failure(
        { channel: "last" },
        { channel: "slack", to: "slack:cron-alerts", accountId: "slack-bot", mode: "announce" },
      ),
    ).toEqual(announce("last"));
  });

  it("clears an inherited global webhook URL when a channel-only override implies announce (#102235)", () => {
    expect(
      failure({ channel: "slack" }, { mode: "webhook", to: "https://hook.example/cron" }),
    ).toEqual(announce("slack"));
  });

  it("rejects webhook mode without a URL", () => {
    expect(failure({ mode: "webhook" })).toBeNull();
  });

  it.each([
    [
      { mode: "announce", channel: "telegram", to: "111", accountId: "bot-a" },
      { mode: "announce", channel: "telegram", to: "111", accountId: "bot-a" },
    ],
    [
      { mode: "announce", channel: "last", to: "telegram:123" },
      { mode: "announce", to: "telegram:123" },
    ],
    [
      { mode: "webhook", to: "https://example.invalid/cron" },
      { mode: "webhook", to: "https://example.invalid/cron" },
    ],
  ] as const)("deduplicates primary %j against failure route %j", (primary, route) => {
    expect(failure(route, undefined, primary)).toBeNull();
  });

  it("does not reuse inherited announce recipient when switching failure destination to webhook", () => {
    expect(
      failure(
        { mode: "webhook" },
        { channel: "signal", to: "group-abc", mode: "announce" },
        { mode: "announce", channel: "telegram", to: "111" },
      ),
    ).toBeNull();
  });

  it("keeps inherited announce targets when a job clears only failure destination mode", () => {
    expect(
      failure(
        { mode: undefined },
        { channel: "signal", to: "group-abc", accountId: "global-account", mode: "announce" },
        { mode: "announce", channel: "telegram", to: "111" },
      ),
    ).toEqual(announce("signal", "group-abc", "global-account"));
  });

  it("does not inherit a foreign global account for a prefixed failure destination", () => {
    expect(
      failure(
        { mode: "announce", to: "slack:U123" },
        { mode: "announce", channel: "telegram", to: "telegram:alerts", accountId: "telegram-bot" },
        { mode: "announce", channel: "telegram", to: "111" },
      ),
    ).toEqual(announce("slack", "slack:U123"));
  });
});
