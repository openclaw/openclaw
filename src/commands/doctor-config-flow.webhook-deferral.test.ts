import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createConfigIO } from "../config/io.factory.js";
import { replaceConfigFile } from "../config/mutate.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import {
  applyPluginDoctorCompatibilityMigrations as migrateCompatibility,
  withDeferredPluginDoctorMigrations as withDeferredMigrations,
} from "../plugins/doctor-contract-registry.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

afterEach(closeStateDatabaseForTest);

it("publishes deferred official Teams listener pins before candidate startup", async () => {
  await withOpenClawTestState(
    { prefix: "openclaw-deferred-teams-", layout: "home" },
    async (state) => {
      const { home, stateDir, configPath } = state;
      const bundledRoot = path.join(home, "bundled");
      const bundledTeams = path.join(bundledRoot, "msteams");
      await fs.mkdir(bundledTeams, { recursive: true });
      const write = (root: string, name: string, data: unknown) =>
        fs.writeFile(path.join(root, name), typeof data === "string" ? data : JSON.stringify(data));
      // Retain the real Teams contract without scanning unrelated bundled plugins.
      const contract = `export * from ${JSON.stringify(pathToFileURL(path.resolve("extensions/msteams/config-doctor-api.ts")).href)};\n`;
      const manifest = { id: "msteams", channels: ["msteams"], configSchema: { type: "object" } };
      await write(bundledTeams, "package.json", { type: "module" });
      for (const entry of ["config-doctor-api.js", "doctor-contract-api.js"]) {
        await write(bundledTeams, entry, contract);
      }
      await write(bundledTeams, "openclaw.plugin.json", manifest);
      Object.assign(state.envVars, {
        OPENCLAW_HOME: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        OPENCLAW_PLUGIN_CATALOG_PATHS: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
      });
      state.applyEnv();
      const config = {
        gateway: { mode: "local" as const },
        channels: { msteams: { enabled: true } },
        plugins: { allow: ["msteams"], entries: { msteams: { enabled: true } } },
      };
      const original = JSON.stringify(config);
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(configPath, original);
      const root = path.join(home, ".openclaw", "extensions", "msteams");
      await fs.mkdir(root, { recursive: true });
      await write(root, "package.json", {
        name: "@openclaw/msteams",
        version: "2026.9.9",
        openclaw: { extensions: ["./index.cjs"] },
      });
      await write(root, "index.cjs", "module.exports = {};\n");
      await write(root, "openclaw.plugin.json", {
        ...manifest,
        channelConfigs: { msteams: { schema: { type: "object" } } },
        doctorContract: { configRepair: true },
      });
      await write(
        root,
        "doctor-contract-api.cjs",
        "module.exports = { normalizeCompatibilityConfig: ({ cfg }) => ({ config: cfg, changes: [] }) };\n",
      );
      await seedInstalledPluginIndex(
        {
          msteams: {
            source: "npm",
            spec: "@openclaw/msteams@2026.9.9",
            resolvedName: "@openclaw/msteams",
            version: "2026.9.9",
            installPath: root,
          },
        },
        { config },
      );
      await recordDeferredPluginMigrations({
        pending: [{ pluginId: "msteams", reason: "pending", command: "openclaw doctor --fix" }],
      });
      const io = createConfigIO({ configPath, observe: false, shellEnvFallback: "defer" });
      const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
      const migration = withDeferredMigrations(
        readDeferredPluginMigrations().map(({ pluginId }) => pluginId),
        () =>
          migrateCompatibility(snapshot.sourceConfig, {
            pluginIds: ["msteams"],
            historicalWebhookListeners: true,
          }),
      );
      await replaceConfigFile({
        io,
        snapshot,
        nextConfig: migration.config,
        writeOptions: { ...writeOptions, observe: false },
      });
      const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(saved.channels.msteams).toEqual({ enabled: true, legacyWebhook: { port: 3978 } });
      expect(saved.meta.migrations.webhookListeners.msteams).toEqual([
        ["channels", "msteams", "legacyWebhook"],
      ]);
      expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(original);
      expect((await runStartupConfigPreflight({ gateway: true })).snapshot.valid).toBe(true);
    },
  );
});
