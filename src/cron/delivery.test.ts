import { afterEach, beforeEach, expect, it } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveCronDeliveryPlan } from "./delivery-plan.js";

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

function announce(channel: string, to?: string, accountId?: string) {
  return { mode: "announce" as const, channel, to, accountId };
}
const webhook = { mode: "webhook", to: "https://example.invalid/cron" } as const;

it("rejects an unrepaired primary route", () => {
  const job = { delivery: announce("telegram", "123") };
  Reflect.deleteProperty(job.delivery, "mode");
  expect(() => resolveCronDeliveryPlan(job)).toThrow("openclaw doctor --fix");
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
