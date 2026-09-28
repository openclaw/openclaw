import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { runSessionTranscriptsHealth } from "../flows/doctor-health-contribution-runners.state.js";
import { resolveLivePluginDoctorStateMigrationInventory } from "../plugins/doctor-contract-registry.js";
import { clearPluginDoctorContractRegistryCache } from "../plugins/doctor-contract-registry.test-fixtures.js";
import {
  readPersistedInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecordsWithLease,
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
  async (existingOwner) => {
    await withHome(async (home) => {
      const bundledRoot = path.join(home, "bundled");
      fs.mkdirSync(bundledRoot, { recursive: true });
      const stateDir = path.join(home, ".openclaw");
      const writePlugin = (pluginId: string) => {
        const root = path.join(bundledRoot, pluginId);
        const markerPath = path.join(stateDir, `${pluginId}-migrated`);
        const action = { id: "session-state", phase: "after-session-repair", doctorOnly: true };
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(
          path.join(root, "package.json"),
          JSON.stringify({
            name: `@test/${pluginId}`,
            version: "0.0.0",
            type: "commonjs",
            openclaw: { extensions: ["./index.cjs"] },
          }),
        );
        fs.writeFileSync(
          path.join(root, "openclaw.plugin.json"),
          JSON.stringify({
            id: pluginId,
            configSchema: {},
            doctorContract: { stateMigrations: [action] },
          }),
        );
        fs.writeFileSync(
          path.join(root, "index.cjs"),
          "throw new Error('runtime must stay unloaded');\n",
        );
        fs.writeFileSync(
          path.join(root, "doctor-contract-api.cjs"),
          `const fs = require("node:fs");
module.exports = { stateMigrations: [{
  ...${JSON.stringify(action)}, label: ${JSON.stringify(pluginId)},
  detectLegacyState: () => fs.existsSync(${JSON.stringify(markerPath)}) ? null : { preview: ["pending"] },
  migrateLegacyState: () => {
    fs.writeFileSync(${JSON.stringify(markerPath)}, "migrated");
    return { changes: [${JSON.stringify(`migrated ${pluginId}`)}], warnings: [] };
  },
}] };\n`,
        );
      };
      const pluginIds = [...(existingOwner ? ["early-owner"] : []), "late-owner"];
      if (existingOwner) {
        writePlugin("early-owner");
      }
      await withEnvAsync(
        {
          OPENCLAW_UPDATE_IN_PROGRESS: undefined,
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
          OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: undefined,
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        },
        async () => {
          const configPath = await writeOpenClawConfig(home, {
            gateway: { mode: "local" },
            agents: { entries: { main: { workspace: path.join(home, "workspace") } } },
            plugins: { allow: pluginIds },
          });
          const install = vi
            .spyOn(pluginInstalls, "repairMissingConfiguredPluginInstalls")
            .mockImplementationOnce(async ({ cfg, env, beforePersistentEffect }) => {
              expect(
                resolveLivePluginDoctorStateMigrationInventory({
                  config: cfg,
                  env: env ?? process.env,
                }).descriptors.map(({ pluginId }) => pluginId),
              ).toEqual(existingOwner ? ["early-owner"] : []);
              return await withPluginLifecycleLease({ env }, async (lease) => {
                const indexOptions = { config: cfg, env, filePath: lease.databasePath, lease };
                const records = readPersistedInstalledPluginIndexInstallRecords(indexOptions) ?? {};
                await beforePersistentEffect?.();
                lease.assertOwned();
                writePlugin("late-owner");
                // Real installs commit the index and revoke enclosing metadata scopes.
                // Merely adding files would leave the simulated installation's facts stale.
                await writePersistedInstalledPluginIndexInstallRecordsWithLease(
                  records,
                  indexOptions,
                );
                return {
                  changes: ["Installed late-owner."],
                  warnings: [],
                  pluginInventoryChanged: true,
                  records,
                };
              });
            });

          const ctx = await prepareDoctorContext(configPath);
          expect(install).toHaveBeenCalledOnce();
          for (const pluginId of pluginIds) {
            expect(fs.existsSync(path.join(stateDir, `${pluginId}-migrated`))).toBe(false);
          }
          assert.ok(ctx.runWithPluginMetadataSnapshot);
          await ctx.runWithPluginMetadataSnapshot({ config: ctx.cfg }, () =>
            runSessionTranscriptsHealth(ctx),
          );
          const receipt = ctx.configResult.stateMigrationStepReceipts?.at(-1);
          expect(receipt, JSON.stringify(receipt)).toMatchObject({
            id: "plugin-doctor-post-session-state",
            outcome: "completed",
            changes: pluginIds.map((pluginId) => `migrated ${pluginId}`),
            warnings: [],
          });
          expect(ctx.configResult.postSessionPluginMigration?.plannedActions).toEqual(
            pluginIds.map((pluginId) => ({ pluginId, id: "session-state" })),
          );
          for (const pluginId of pluginIds) {
            expect(fs.readFileSync(path.join(stateDir, `${pluginId}-migrated`), "utf8")).toBe(
              "migrated",
            );
          }
        },
      );
    });
  },
);
