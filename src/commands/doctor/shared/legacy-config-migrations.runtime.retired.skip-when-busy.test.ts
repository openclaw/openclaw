import { expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";

it("preserves heartbeat skipWhenBusy while removing retired heartbeat tuning", () => {
  const raw = {
    agents: {
      defaults: { heartbeat: { ackMaxChars: 10, includeReasoning: true, skipWhenBusy: true } },
      entries: { main: { heartbeat: { skipWhenBusy: false } } },
    },
  };
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED) {
    migration.apply(raw, changes);
  }

  expect(raw).toHaveProperty("agents.defaults.heartbeat.skipWhenBusy", true);
  expect(raw).toHaveProperty("agents.entries.main.heartbeat.skipWhenBusy", false);
  expect(raw).not.toHaveProperty("agents.defaults.heartbeat.ackMaxChars");
  expect(raw).not.toHaveProperty("agents.defaults.heartbeat.includeReasoning");
});
