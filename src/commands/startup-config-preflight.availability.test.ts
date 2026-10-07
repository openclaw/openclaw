import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as safeCwd from "../infra/safe-cwd.js";
import {
  readStartupMigrationWarning,
  recordStartupMigrationWarnings,
} from "../infra/state-migrations.messages.js";
import {
  listActiveDegradedPlugins,
  setActiveDegradedPlugins,
} from "../plugins/runtime-degraded-state.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readConfigPreflightSnapshot } from "./config-preflight-snapshot.js";
import { refreshStartupPluginQuarantine } from "./doctor-config-preflight-plugin-verification.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

afterEach(() => {
  setActiveDegradedPlugins([]);
  recordStartupMigrationWarnings([]);
  closeOpenClawStateDatabaseForTest();
});

it.each(["npm", "clawhub", "wrong-package", "revoked"] as const)(
  "restores only a verified missing plugin backup at startup (%s)",
  async (source) => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const pluginId = "backup-recovery-fixture";
        const packageName = `@example/${pluginId}`;
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const installPath = path.join(stateDir, "extensions", pluginId);
        const backupPath = path.join(
          path.dirname(installPath),
          ".openclaw-install-backups",
          `${pluginId}-00000000-0000-4000-8000-000000000000`,
        );
        await fs.mkdir(backupPath, { recursive: true });
        const fixture = createColdPluginFixture({
          rootDir: backupPath,
          pluginId,
          packageName: source === "wrong-package" ? "@example/unrelated" : packageName,
          packageVersion: "1.0.0",
        });
        const config = {
          gateway: { mode: "local" as const, auth: { mode: "none" as const } },
          plugins: { allow: [pluginId], entries: { [pluginId]: { enabled: true } } },
          meta: { migrations: { webhookListeners: true as const } },
        };
        const configBytes = `${JSON.stringify(config)}\n`;
        await fs.writeFile(configPath, configBytes);
        await seedInstalledPluginIndex(
          {
            [pluginId]: {
              ...(source === "npm"
                ? { source: "npm" as const, spec: `${packageName}@1.0.0` }
                : {
                    source: "clawhub" as const,
                    spec: `clawhub:${packageName}@1.0.0`,
                    clawhubPackage: packageName,
                  }),
              version: "1.0.0",
              installPath,
            },
          },
          { config },
        );

        if (source === "revoked") {
          let authorityLive = true;
          await expect(
            refreshStartupPluginQuarantine({
              cfg: config,
              env: process.env,
              assertCurrent: () => {
                if (!authorityLive) {
                  throw new Error("startup authority revoked");
                }
              },
              beforePersistentEffect: async () => {
                authorityLive = false;
              },
            }),
          ).rejects.toThrow("startup authority revoked");
          expect(fsSync.existsSync(installPath)).toBe(false);
          expect(fsSync.existsSync(backupPath)).toBe(true);
          expect(await fs.readFile(configPath, "utf8")).toBe(configBytes);
          return;
        }

        const ready = await runStartupConfigPreflight({ gateway: true, observe: false });

        expect(ready.snapshot.valid).toBe(true);
        expect(await fs.readFile(configPath, "utf8")).toBe(configBytes);
        expect(fsSync.existsSync(backupPath)).toBe(true);
        expect(fsSync.existsSync(fixture.runtimeMarker)).toBe(false);
        if (source === "wrong-package") {
          expect(fsSync.existsSync(installPath)).toBe(false);
          expect(listActiveDegradedPlugins()).toMatchObject([
            { pluginId, diagnostic: { reason: "missing-package-dir" } },
          ]);
          expect(readStartupMigrationWarning()).toContain("openclaw update repair");
        } else {
          expect(await fs.readFile(path.join(installPath, "index.cjs"), "utf8")).toBe(
            await fs.readFile(fixture.runtimeSource, "utf8"),
          );
          expect(listActiveDegradedPlugins()).toEqual([]);
          expect(ready.pluginMetadataSnapshot?.byPluginId.get(pluginId)).toMatchObject({
            rootDir: installPath,
            packageVersion: "1.0.0",
          });
        }
      });
    });
  },
);

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
        meta: { migrations: { webhookListeners: true as const } },
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
      expect(readStartupMigrationWarning()).toContain(
        "Retired runtime state was left unchanged for Doctor; no import was attempted.",
      );
      expect(readStartupMigrationWarning()).toContain(sourcePath);
      expect(await fs.readFile(configPath, "utf8")).toBe(configBytes);
      expect(await fs.readFile(sourcePath, "utf8")).toBe(sourceBytes);
      expect(readConfigMachineState("voicewake.triggers")).toBeUndefined();
      expect(await fs.readdir(path.dirname(sourcePath))).toEqual(["voicewake.json"]);
    });
  });
});

it.each(["no-home", "EACCES"] as const)(
  "continues prepared startup when retired-state inspection fails (%s)",
  async (fault) => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const sourcePath = path.join(stateDir, "settings", "voicewake.json");
        const config = {
          gateway: { mode: "local" as const },
          plugins: { enabled: false },
          meta: { migrations: { webhookListeners: true as const } },
        };
        const configBytes = `${JSON.stringify(config)}\n`;
        const sourceBytes = '{"triggers":["leave-for-doctor"]}\n';
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.writeFile(configPath, configBytes);
        await fs.writeFile(sourcePath, sourceBytes);
        await seedInstalledPluginIndex({}, { config });

        const lstat = fsSync.lstatSync;
        try {
          if (fault === "EACCES") {
            vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
              if (args[0] === sourcePath) {
                throw Object.assign(new Error(`EACCES: permission denied, lstat ${sourcePath}`), {
                  code: "EACCES",
                });
              }
              return lstat(...args);
            });
          }
          const ready = await runStartupConfigPreflight({
            gateway: fault === "EACCES",
            observe: false,
            ...(fault === "no-home"
              ? {
                  beforeStatePreparation: async () => {
                    // Configuration is prepared; the service has only explicit state paths.
                    for (const key of ["OPENCLAW_HOME", "HOME", "USERPROFILE", "PREFIX"]) {
                      vi.stubEnv(key, undefined);
                    }
                    vi.spyOn(os, "homedir").mockReturnValue("");
                    vi.spyOn(safeCwd, "tryProcessCwd").mockReturnValue(undefined);
                    return true;
                  },
                }
              : {}),
          });

          expect(ready.snapshot.valid).toBe(true);
          expect(readStartupMigrationWarning()).toContain(
            "Could not inspect retired runtime state:",
          );
          expect(readStartupMigrationWarning()).toContain("; run openclaw doctor");
          expect(readStartupMigrationWarning()).toContain(
            fault === "no-home"
              ? "Unable to resolve an OpenClaw home"
              : `EACCES: permission denied, lstat ${sourcePath}`,
          );
        } finally {
          vi.restoreAllMocks();
          vi.unstubAllEnvs();
        }
        expect(await fs.readFile(configPath, "utf8")).toBe(configBytes);
        expect(await fs.readFile(sourcePath, "utf8")).toBe(sourceBytes);
      });
    });
  },
);

it.each([false, true])(
  "loads plugin repair diagnostics only for invalid startup config (invalid: %s)",
  async (invalid) => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const pluginId = "repair-fixture";
        const pluginDir = path.join(home, "plugins", pluginId);
        const marker = path.join(home, "doctor-loaded");
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        await fs.mkdir(pluginDir, { recursive: true });
        await fs.writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: pluginId,
            doctorContract: { configRepair: true },
            configSchema: { type: "object", additionalProperties: false },
          }),
        );
        await fs.writeFile(path.join(pluginDir, "index.cjs"), "exports.register = () => {};\n");
        await fs.writeFile(
          path.join(pluginDir, "doctor-contract-api.cjs"),
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");
exports.legacyConfigRules = [{
  path: ["plugins", "entries", "${pluginId}", "config", "retired"],
  message: "Remove the retired fixture setting."
}];\n`,
        );
        const config = {
          gateway: { mode: "local" as const, auth: { mode: "none" as const } },
          plugins: {
            allow: [pluginId],
            load: { paths: [pluginDir] },
            entries: { [pluginId]: { enabled: true, config: invalid ? { retired: true } : {} } },
          },
          meta: { migrations: { webhookListeners: true as const } },
        };
        const configBytes = `${JSON.stringify(config)}\n`;
        await fs.writeFile(configPath, configBytes);
        await seedInstalledPluginIndex({}, { config });

        const ready = await runStartupConfigPreflight({ gateway: true, observe: false });

        expect(ready.snapshot.valid).toBe(!invalid);
        expect(await fs.readFile(configPath, "utf8")).toBe(configBytes);
        if (invalid) {
          expect(await fs.readFile(marker, "utf8")).toBe("loaded");
          expect(ready.snapshot.legacyIssues).toContainEqual({
            path: `plugins.entries.${pluginId}.config.retired`,
            message: "Remove the retired fixture setting.",
          });
        } else {
          await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
          await readConfigPreflightSnapshot({
            purpose: "doctor",
            allowCurrentPluginMetadata: false,
            includePluginMetadata: true,
            skipPluginValidation: false,
            observe: false,
          });
          expect(await fs.readFile(marker, "utf8")).toBe("loaded");
        }
      });
    });
  },
);
