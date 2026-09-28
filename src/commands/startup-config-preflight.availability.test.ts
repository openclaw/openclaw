import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  readStartupMigrationWarning,
  recordStartupMigrationWarnings,
} from "../infra/state-migrations.messages.js";
import {
  listActiveDegradedPlugins,
  setActiveDegradedPlugins,
} from "../plugins/runtime-degraded-state.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

afterEach(() => {
  setActiveDegradedPlugins([]);
  recordStartupMigrationWarnings([]);
  closeOpenClawStateDatabaseForTest();
});

it("admits an unavailable plugin while leaving legacy state for Doctor", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const sourcePath = path.join(stateDir, "settings", "voicewake.json");
      const pluginId = "unavailable-fixture";
      const config = {
        gateway: { mode: "local" as const, auth: { mode: "none" as const } },
        plugins: { allow: [pluginId], entries: { [pluginId]: { enabled: true } } },
      };
      const configBytes = `${JSON.stringify(config)}\n`;
      const sourceBytes = '{"triggers":["leave-for-doctor"]}\n';
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(configPath, configBytes);
      await fs.writeFile(sourcePath, sourceBytes);
      await seedInstalledPluginIndex(
        { [pluginId]: { source: "npm", spec: `${pluginId}@1.0.0` } },
        { config },
      );

      const ready = await runStartupConfigPreflight({ gateway: true, observe: false });

      expect(ready.snapshot.valid).toBe(true);
      expect(listActiveDegradedPlugins()).toMatchObject([
        {
          pluginId,
          state: "configured-unavailable",
          diagnostic: { reason: "missing-install-path" },
        },
      ]);
      expect(readStartupMigrationWarning()).toContain(`Plugin "${pluginId}"`);
      expect(readStartupMigrationWarning()).toContain("openclaw update repair");
      expect(await fs.readFile(configPath, "utf8")).toBe(configBytes);
      expect(await fs.readFile(sourcePath, "utf8")).toBe(sourceBytes);
      expect(readConfigMachineState("voicewake.triggers")).toBeUndefined();
      expect(await fs.readdir(path.dirname(sourcePath))).toEqual(["voicewake.json"]);
    });
  });
});
