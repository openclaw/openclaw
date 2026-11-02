import { afterEach, beforeEach, expect, it } from "vitest";
import type { CronFailureDestinationConfig } from "../config/types.cron.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveCronDeliveryPlan, resolveFailureDestination } from "./delivery-plan.js";
import type { CronDelivery } from "./types.js";

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry(
      (
        [
          ["telegram", "tg"],
          ["slack"],
          ["googlechat", "gchat", "google-chat"],
          ["msteams", "teams"],
          ["synology-chat", "synology_chat", "synology"],
        ] as const
      ).map(([id, ...aliases]) => {
        const base = createChannelTestPluginBase({ id });
        return {
          pluginId: id,
          source: `test:${id}`,
          plugin: {
            ...base,
            meta: { ...base.meta, aliases },
            messaging: { targetPrefixes: [id, ...aliases] },
          },
        };
      }),
    ),
  );
});
afterEach(() => resetPluginRuntimeStateForTest());

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
const webhook = { mode: "webhook", to: "https://example.invalid/cron" } as const;

it("rejects an unrepaired primary route while retaining an explicit failure destination", () => {
  const job = { delivery: announce("telegram", "123") };
  Reflect.deleteProperty(job.delivery, "mode");
  expect(() => resolveCronDeliveryPlan(job)).toThrow("openclaw doctor --fix");
  expect(resolveFailureDestination(job, { channel: "telegram", to: "123" })).toEqual(
    announce("telegram", "123"),
  );
});

it("resolves webhook mode without channel routing", () => {
  expect(resolveCronDeliveryPlan({ delivery: webhook })).toMatchObject({
    ...webhook,
    requested: false,
    channel: undefined,
  });
});

it("uses Synology Chat provider prefixes with underscores and short spelling", () => {
  for (const to of ["synology-chat:123", "synology_chat:123", "synology:123"]) {
    expect(
      resolveCronDeliveryPlan({ delivery: { mode: "announce", channel: "last", to } }),
    ).toMatchObject({ mode: "announce", channel: "synology-chat", to });
  }
});

it("preserves msteams failure routing from its global alias through a job alert", () => {
  expect(
    resolveFailureDestination(
      { delivery: { mode: "none" } },
      announce("teams", "msteams:alerts", "msteams-bot"),
      { channel: "msteams" },
    ),
  ).toEqual(announce("msteams", "msteams:alerts", "msteams-bot"));
});

const slack = announce("slack", "slack:cron-alerts", "slack-bot");
const signal = announce("signal", "group-abc", "global-account");
const telegram = announce("telegram", "telegram:alerts", "telegram-bot");

it.each([
  [announce("telegram", "111", "bot-a"), announce("telegram", "111", "bot-a")],
  [announce("last", "telegram:123"), { mode: "announce", to: "telegram:123" }],
  [webhook, webhook],
] as const)("deduplicates primary %j against failure route %j", (primary, route) => {
  expect(failure(route, undefined, primary)).toBeNull();
});

it.each([
  [
    "foreign channel",
    { channel: "teams" },
    announce("gchat", "googlechat:alerts", "googlechat-bot"),
    announce("msteams"),
  ],
  ["last channel", { channel: "last" }, slack, announce("last")],
  ["webhook to channel", { channel: "slack" }, webhook, announce("slack")],
  ["missing webhook URL", { mode: "webhook" }, undefined, null],
  ["announce to webhook", { mode: "webhook" }, announce("signal", "group-abc"), null],
  ["undefined mode", { mode: undefined }, signal, signal],
  [
    "prefixed target",
    { mode: "announce", to: "slack:U123" },
    telegram,
    announce("slack", "slack:U123"),
  ],
] as const)(
  "merges %s override without crossing routing ownership",
  (_name, override, inherited, expected) => {
    expect(failure(override, inherited, announce("telegram", "111"))).toEqual(expected);
  },
);
