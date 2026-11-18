import { expect, it } from "vitest";
import { migrateLegacyConfigForTest } from "./legacy-config-migrate.apply.test-support.js";

it("retires scoped failure routes without moving result routes or the global policy", () => {
  const global = { after: 3, cooldownMs: 60_000, channel: "telegram", to: "123" };
  const resultRoute = { channel: "slack", to: "C123" };
  const migrated = migrateLegacyConfigForTest({
    cron: {
      failureAlert: global,
      agents: { ops: { delivery: resultRoute, failureAlert: { channel: "telegram", to: "456" } } },
      creators: { alice: { failureAlert: { channel: "slack", to: "C456" } } },
    },
  });
  expect(migrated.config?.cron).toEqual({
    failureAlert: global,
    agents: { ops: { delivery: resultRoute } },
    creators: {},
  });
  expect(migrated.changes.join("\n")).toContain("cron.agents.ops.failureAlert");
  expect(migrated.changes.join("\n")).toContain("cron.creators.alice.failureAlert");
  expect(migrateLegacyConfigForTest(migrated.config)).toEqual({ config: null, changes: [] });
});
