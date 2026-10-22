import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { runSessionTranscriptsHealth } from "../flows/doctor-health-contribution-runners.state.js";
import { resolveLivePluginDoctorStateMigrationInventory as resolveMigrations } from "../plugins/doctor-contract-registry.js";
import { clearPluginDoctorContractRegistryCache } from "../plugins/doctor-contract-registry.test-fixtures.js";
import {
  readPersistedInstalledPluginIndexInstallRecordsAsync as readInstallRecords,
  writePersistedInstalledPluginIndexInstallRecordsWithLease as writeInstallRecords,
} from "../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { useDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import * as pluginInstalls from "./doctor/shared/missing-configured-plugin-install.js";

const withHome = useDoctorConfigPreflightHome();
afterEach(() => {
  vi.restoreAllMocks();
  clearPluginDoctorContractRegistryCache();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each([false, true])(
  "plans newly installed session owners after preflight (existing owner: %s)",
  (existingOwner) =>
    withHome(async (home) => {
      const bundledRoot = path.join(home, "bundled");
      fs.mkdirSync(bundledRoot, { recursive: true });
      const stateDir = path.join(home, ".openclaw");
      const writePlugin = (pluginId: string) => {
        const root = path.join(bundledRoot, pluginId);
        const markerPath = path.join(stateDir, `${pluginId}-migrated`);
        const action = { id: "session-state", phase: "after-session-repair", doctorOnly: true };
        fs.mkdirSync(root, { recursive: true });
        const files = {
          "package.json": JSON.stringify({ openclaw: { extensions: ["./index.cjs"] } }),
          "openclaw.plugin.json": JSON.stringify({
            id: pluginId,
            configSchema: {},
            doctorContract: { stateMigrations: [action] },
          }),
          "index.cjs": "throw new Error('runtime must stay unloaded');\n",
          "doctor-contract-api.cjs": `const fs = require("node:fs");
module.exports = { stateMigrations: [{
  ...${JSON.stringify(action)}, label: ${JSON.stringify(pluginId)},
  detectLegacyState: () => fs.existsSync(${JSON.stringify(markerPath)}) ? null : { preview: ["pending"] },
  migrateLegacyState: () => {
    fs.writeFileSync(${JSON.stringify(markerPath)}, "migrated");
    return { changes: [${JSON.stringify(`migrated ${pluginId}`)}], warnings: [] };
  },
}] };\n`,
        };
        for (const [name, content] of Object.entries(files)) {
          fs.writeFileSync(path.join(root, name), content);
        }
      };
      const pluginIds = [...(existingOwner ? ["early-owner"] : []), "late-owner"];
      if (existingOwner) {
        writePlugin("early-owner");
      }
      const fixtureEnv = {
        OPENCLAW_UPDATE_IN_PROGRESS: undefined,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: undefined,
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      };
      await withEnvAsync(fixtureEnv, async () => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
          agents: { entries: { main: { workspace: path.join(home, "workspace") } } },
          plugins: { allow: pluginIds },
        });
        const install = vi
          .spyOn(pluginInstalls, "repairMissingConfiguredPluginInstalls")
          .mockImplementationOnce(async ({ cfg, env, beforePersistentEffect }) => {
            const inventory = resolveMigrations({ config: cfg, env: env ?? process.env });
            expect(inventory.descriptors.map(({ pluginId }) => pluginId)).toEqual(
              existingOwner ? ["early-owner"] : [],
            );
            return await withPluginLifecycleLease({ env }, async (lease) => {
              const indexOptions = { config: cfg, env, filePath: lease.databasePath, lease };
              const records = (await readInstallRecords(indexOptions)) ?? {};
              await beforePersistentEffect?.();
              lease.assertOwned();
              writePlugin("late-owner");
              // Commit the real index to revoke enclosing metadata scopes.
              await writeInstallRecords(records, indexOptions);
              return {
                changes: ["Installed late-owner."],
                warnings: [],
                pluginInventoryChanged: true,
                records,
              };
            });
          });

        await using ctx = await prepareDoctorContext(configPath);
        expect(install).toHaveBeenCalledOnce();
        const markers = pluginIds.map((id) => path.join(stateDir, `${id}-migrated`));
        expect(markers.map((file) => fs.existsSync(file))).toEqual(pluginIds.map(() => false));
        assert.ok(ctx.runWithPluginMetadataSnapshot);
        await ctx.runWithPluginMetadataSnapshot({ config: ctx.cfg }, () =>
          runSessionTranscriptsHealth(ctx),
        );
        expect(ctx.configResult.stateMigrationStepReceipts?.at(-1)).toMatchObject({
          id: "plugin-doctor-post-session-state",
          outcome: "completed",
          changes: pluginIds.map((pluginId) => `migrated ${pluginId}`),
          warnings: [],
        });
        expect(ctx.configResult.postSessionPluginMigration?.plannedActions).toEqual(
          pluginIds.map((pluginId) => ({ pluginId, id: "session-state" })),
        );
        expect(markers.map((file) => fs.readFileSync(file, "utf8"))).toEqual(
          pluginIds.map(() => "migrated"),
        );
      });
    }),
);
