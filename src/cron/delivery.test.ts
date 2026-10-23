import { afterEach, beforeEach, expect, it } from "vitest";
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
  return { mode: "announce" as const, channel, to, accountId };
}

const baseChannels = () => [
  channelPlugin("telegram", ["telegram", "tg"]),
  channelPlugin("slack", ["slack"]),
  channelPlugin("googlechat", ["googlechat", "gchat", "google-chat"], ["gchat", "google-chat"]),
];
beforeEach(() => register(baseChannels()));
afterEach(() => resetPluginRuntimeStateForTest());

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

it("preserves msteams failure routing from its global alias through a job alert", () => {
  register([...baseChannels(), channelPlugin("msteams", ["msteams", "teams"], ["teams"])]);
  expect(
    resolveFailureDestination(
      { delivery: { mode: "none" } },
      announce("teams", "msteams:alerts", "msteams-bot"),
      { channel: "msteams" },
    ),
  ).toEqual(announce("msteams", "msteams:alerts", "msteams-bot"));
});

it.each([
  ["teams", announce("gchat", "googlechat:alerts", "googlechat-bot"), "msteams"],
  ["last", announce("slack", "slack:cron-alerts", "slack-bot"), "last"],
  ["slack", { mode: "webhook", to: "https://hook.example/cron" }, "slack"],
] as const)(
  "does not reuse foreign routing for channel override %s",
  (channel, inherited, expected) => {
    register([...baseChannels(), channelPlugin("msteams", ["msteams", "teams"], ["teams"])]);
    expect(failure({ channel }, inherited)).toEqual(announce(expected));
  },
);

it("rejects webhook mode without a URL", () => {
  expect(failure({ mode: "webhook" })).toBeNull();
});

it.each([
  [announce("telegram", "111", "bot-a"), announce("telegram", "111", "bot-a")],
  [announce("last", "telegram:123"), { mode: "announce", to: "telegram:123" }],
  [
    { mode: "webhook", to: "https://example.invalid/cron" },
    { mode: "webhook", to: "https://example.invalid/cron" },
  ],
] as const)("deduplicates primary %j against failure route %j", (primary, route) => {
  expect(failure(route, undefined, primary)).toBeNull();
});

it.each([
  [{ mode: "webhook" }, announce("signal", "group-abc"), null],
  [
    { mode: undefined },
    announce("signal", "group-abc", "global-account"),
    announce("signal", "group-abc", "global-account"),
  ],
  [
    { mode: "announce", to: "slack:U123" },
    announce("telegram", "telegram:alerts", "telegram-bot"),
    announce("slack", "slack:U123"),
  ],
] as const)(
  "merges failure override %j without crossing routing ownership",
  (override, inherited, expected) => {
    expect(failure(override, inherited, announce("telegram", "111"))).toEqual(expected);
  },
);
