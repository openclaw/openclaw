import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { withPluginGenerationSourceCustody } from "../plugins/plugin-generation-source-lookup.js";
import { writeArtifacts } from "../plugins/public-surface.test-support.js";
import { runPostSessionPluginDoctorStateRepairs } from "./state-migrations.plugin-doctor.js";
import { closeDefaultRetainedNativeWorkerSource } from "./worker-native-lifecycle.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeDefaultRetainedNativeWorkerSource();
});

it.each([
  {
    name: "disabled pending owner",
    enabled: false,
    inspectDisabled: true,
    pending: true,
    inspected: true,
  },
  {
    name: "disabled completed owner",
    enabled: false,
    inspectDisabled: true,
    pending: false,
    inspected: true,
  },
  { name: "enabled owner", enabled: true, inspectDisabled: false, pending: false, inspected: true },
  {
    name: "disabled owner without inspection",
    enabled: false,
    inspectDisabled: false,
    pending: false,
    inspected: false,
  },
  {
    name: "disabled owner without migrations",
    enabled: false,
    inspectDisabled: true,
    pending: false,
    inspected: false,
    noMigrations: true,
  },
])("inspects $name without activating or repairing it", async (scenario) => {
  expect(isMainThread).toBe(true);
  const stateDir = dirs.make("doctor-disabled-state-");
  const pluginRoot = dirs.make("doctor-disabled-plugin-");
  const pluginId = "inspection-fixture";
  const events = path.join(stateDir, "events.txt");
  writeArtifacts(pluginRoot, {
    "package.json": {
      name: "@fixture/inspection",
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    },
    "openclaw.plugin.json": {
      id: pluginId,
      configSchema: { type: "object" },
      doctorContract: scenario.noMigrations
        ? { configRepair: true }
        : { stateMigrations: [{ id: "retained-state" }] },
    },
    "index.cjs": "throw new Error('inspection must not load plugin runtime');",
    "doctor-contract-api.cjs": scenario.noMigrations
      ? "throw new Error('state inspection must not load a config-only contract');"
      : `const fs = require('node:fs');
        module.exports = { stateMigrations: [{
          id: 'retained-state', label: 'Retained state',
          detectLegacyState() {
            fs.appendFileSync(${JSON.stringify(events)}, 'detect\\n');
            return ${scenario.pending ? "{ preview: ['retained work'] }" : "null"};
          },
          migrateLegacyState() { throw new Error('inspection must not repair state'); }
        }] };`,
  });
  const config = {
    plugins: {
      load: { paths: [pluginRoot] },
      entries: { [pluginId]: { enabled: scenario.enabled } },
    },
  };
  const env = {
    ...process.env,
    HOME: stateDir,
    OPENCLAW_HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  await using cache = createPluginCache();
  const result = await withPluginCache(cache, () =>
    withPluginGenerationSourceCustody(() =>
      runPostSessionPluginDoctorStateRepairs({
        config,
        env,
        inspectPluginIds: [pluginId],
        inspectDisabled: scenario.inspectDisabled,
      }),
    ),
  );
  expect(result.changes).toEqual([]);
  expect(result.requiredPluginIds ?? []).toEqual(scenario.inspected ? [pluginId] : []);
  expect(result.completedPluginIds ?? []).toEqual(
    scenario.inspected && !scenario.pending ? [pluginId] : [],
  );
  expect(result.warnings).toEqual(
    scenario.pending
      ? [expect.stringContaining("data/settings upgrade is blocked in default: Retained state")]
      : [],
  );
  expect(fs.existsSync(events) ? fs.readFileSync(events, "utf8") : "").toBe(
    scenario.inspected ? "detect\n" : "",
  );
});
