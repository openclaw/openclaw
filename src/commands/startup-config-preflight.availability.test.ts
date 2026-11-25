import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as terminalNotes from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.js";
import * as safeCwd from "../infra/safe-cwd.js";
import {
  readStartupMigrationWarning,
  recordStartupMigrationWarnings,
} from "../infra/state-migrations.messages.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { resolvePluginNpmProjectDir } from "../plugins/install-paths.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../plugins/installed-plugin-index-records.js";
import {
  listActiveDegradedPlugins,
  setActiveDegradedPlugins,
} from "../plugins/runtime-degraded-state.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createConfigPreflightSnapshotReader } from "./config-preflight-snapshot.js";
import { refreshStartupPluginQuarantine } from "./doctor-config-preflight-plugin-verification.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

const sourceBytes = '{"triggers":["leave-for-doctor"]}\n';
const migrationMeta = { migrations: { webhookListeners: true as const } };
const pluginId = "fixture";
const localGateway = { mode: "local" as const, auth: { mode: "none" as const } };

async function writeJson(file: string, value: unknown) {
  const bytes = `${JSON.stringify(value)}\n`;
  await fs.writeFile(file, bytes);
  return bytes;
}

async function withStartupHome(run: (home: string) => Promise<void>) {
  return withDoctorConfigPreflightHome((home) =>
    withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, () => run(home)),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  setActiveDegradedPlugins([]);
  recordStartupMigrationWarnings([]);
  closeOpenClawStateDatabaseForTest();
});

it.each(["present", "missing"])(
  "repairs owned host links after an external installation-root change (old root %s)",
  (oldRootState) =>
    withStartupHome(async (home) => {
      const notes = vi.spyOn(terminalNotes, "note");
      const stateDir = path.join(home, ".openclaw");
      const oldRoot = path.join(home, "old-node", "lib", "node_modules", "openclaw");
      const currentRoot = fsSync.realpathSync(process.cwd());
      if (oldRootState === "present") {
        await fs.mkdir(oldRoot, { recursive: true });
        await writeJson(path.join(oldRoot, "package.json"), { name: "openclaw" });
      }
      const managedRoot = resolvePluginNpmProjectDir({
        npmDir: path.join(stateDir, "npm"),
        packageName: "@fixture/managed",
      });
      const packageDirs = {
        managed: path.join(managedRoot, "node_modules", "@fixture", "managed"),
        registered: path.join(stateDir, "extensions", "registered"),
        local: path.join(home, "local-plugin"),
      };
      const records = Object.fromEntries(
        Object.entries(packageDirs).map(([id, installPath]) => [
          id,
          { source: id === "local" ? ("path" as const) : ("npm" as const), installPath },
        ]),
      );
      for (const [id, packageDir] of Object.entries(packageDirs)) {
        await fs.mkdir(path.join(packageDir, "node_modules"), { recursive: true });
        await writeJson(path.join(packageDir, "package.json"), {
          name: `@fixture/${id}`,
          version: "1.0.0",
          peerDependencies: { openclaw: "*" },
          openclaw: { extensions: ["./index.js"] },
        });
        await writeJson(path.join(packageDir, "openclaw.plugin.json"), {
          id,
          configSchema: { type: "object" },
        });
        await fs.writeFile(path.join(packageDir, "index.js"), "export default {};\n");
        await fs.symlink(oldRoot, path.join(packageDir, "node_modules", "openclaw"), "junction");
      }
      const config = {
        gateway: localGateway,
        plugins: { allow: Object.keys(packageDirs) },
        meta: migrationMeta,
      };
      const configPath = path.join(stateDir, "openclaw.json");
      const configBytes = await writeJson(configPath, config);
      await seedInstalledPluginIndex(records, { config });
      const recordsBefore = await readPersistedInstalledPluginIndexInstallRecordsAsync();

      if (oldRootState === "present") {
        await refreshStartupPluginQuarantine({
          cfg: config,
          env: {
            ...buildUpdateRehearsalPathEnv(stateDir),
            OPENCLAW_UPDATE_IN_PROGRESS: "0",
            OPENCLAW_SERVICE_REPAIR_POLICY: "external",
            OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
            OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
          },
        });
        expect(await fs.readlink(path.join(packageDirs.managed, "node_modules", "openclaw"))).toBe(
          oldRoot,
        );
      }

      const ready = await runStartupConfigPreflight({ gateway: true, observe: false });
      try {
        expect(ready.snapshot.valid).toBe(true);
        for (const id of ["managed", "registered"] as const) {
          expect(await fs.realpath(path.join(packageDirs[id], "node_modules", "openclaw"))).toBe(
            currentRoot,
          );
        }
        expect(listActiveDegradedPlugins()).toEqual([]);
        expect(notes.mock.calls.flat().join("\n")).toContain(`${oldRoot} -> ${currentRoot}`);
        expect(readStartupMigrationWarning()).toBeUndefined();
        expect(await fs.readlink(path.join(packageDirs.local, "node_modules", "openclaw"))).toBe(
          oldRoot,
        );
        expect(await fs.readFile(configPath, "utf8")).toBe(configBytes);
      } finally {
        await ready.pluginCache?.[Symbol.asyncDispose]();
      }
      const peerLink = path.join(packageDirs.managed, "node_modules", "openclaw");
      const firstLink = await fs.lstat(peerLink);
      notes.mockClear();
      recordStartupMigrationWarnings([]);
      const repeated = await runStartupConfigPreflight({ gateway: true, observe: false });
      try {
        expect(await fs.lstat(peerLink)).toMatchObject({
          ino: firstLink.ino,
          mtimeMs: firstLink.mtimeMs,
        });
        expect(readStartupMigrationWarning()).toBeUndefined();
        expect(notes.mock.calls.flat().join("\n")).not.toContain("Repaired OpenClaw host link");
        expect(await readPersistedInstalledPluginIndexInstallRecordsAsync()).toEqual(recordsBefore);
        expect(await fs.readFile(configPath, "utf8")).toBe(configBytes);
      } finally {
        await repeated.pluginCache?.[Symbol.asyncDispose]();
      }
    }),
);

it.each(["unavailable", "no-home", "EACCES"])(
  "preserves retired state during %s startup",
  (fault) =>
    withStartupHome(async (home) => {
      const unavailable = fault === "unavailable";
      const config: OpenClawConfig = {
        gateway: unavailable ? localGateway : { mode: "local" },
        plugins: unavailable
          ? { allow: [pluginId], entries: { [pluginId]: { enabled: true } } }
          : { enabled: false },
        meta: migrationMeta,
      };
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const sourcePath = path.join(home, ".openclaw", "settings", "voicewake.json");
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      const configBytes = await writeJson(configPath, config);
      await fs.writeFile(sourcePath, sourceBytes);
      await seedInstalledPluginIndex(
        unavailable ? { [pluginId]: { source: "npm", spec: `${pluginId}@1.0.0` } } : {},
        { config },
      );
      const lstat = fsSync.lstatSync;
      const denied = `EACCES: permission denied, lstat ${sourcePath}`;
      try {
        if (fault === "EACCES") {
          vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
            if (args[0] === sourcePath) {
              throw Object.assign(new Error(denied), { code: "EACCES" });
            }
            return lstat(...args);
          });
        }
        const ready = await runStartupConfigPreflight({
          gateway: fault !== "no-home",
          observe: false,
          beforeStatePreparation:
            fault === "no-home"
              ? async () => {
                  for (const key of ["OPENCLAW_HOME", "HOME", "USERPROFILE", "PREFIX"]) {
                    vi.stubEnv(key, undefined);
                  }
                  vi.spyOn(os, "homedir").mockReturnValue("");
                  vi.spyOn(safeCwd, "tryProcessCwd").mockReturnValue(undefined);
                  return true;
                }
              : undefined,
        });
        expect(ready.snapshot.valid).toBe(true);
        const warning = readStartupMigrationWarning();
        if (unavailable) {
          expect(listActiveDegradedPlugins()).toMatchObject([
            {
              pluginId,
              state: "configured-unavailable",
              diagnostic: { reason: "missing-install-path" },
            },
          ]);
          for (const part of [
            `Plugin "${pluginId}"`,
            "openclaw update repair",
            "Retired runtime state was left unchanged for Doctor; no import was attempted.",
            sourcePath,
          ]) {
            expect(warning).toContain(part);
          }
          expect(readConfigMachineState("voicewake.triggers")).toBeUndefined();
          expect(await fs.readdir(path.dirname(sourcePath))).toEqual(["voicewake.json"]);
        } else {
          expect(warning).toContain("Could not inspect retired runtime state:");
          expect(warning).toContain("; run openclaw doctor");
          expect(warning).toContain(
            fault === "no-home" ? "Unable to resolve an OpenClaw home" : denied,
          );
        }
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
      expect(await fs.readFile(configPath, "utf8")).toBe(configBytes);
      expect(await fs.readFile(sourcePath, "utf8")).toBe(sourceBytes);
    }),
);
it.each([false, true])(
  "loads plugin repair diagnostics only for invalid startup config (invalid: %s)",
  (invalid) =>
    withStartupHome(async (home) => {
      const pluginDir = path.join(home, "plugins", pluginId);
      const marker = path.join(home, "doctor-loaded");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(pluginDir, { recursive: true });
      await writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
        id: pluginId,
        doctorContract: { configRepair: true },
        configSchema: { type: "object", additionalProperties: false },
      });
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
        gateway: localGateway,
        plugins: {
          allow: [pluginId],
          load: { paths: [pluginDir] },
          entries: { [pluginId]: { enabled: true, config: invalid ? { retired: true } : {} } },
        },
        meta: migrationMeta,
      };
      const configBytes = await writeJson(configPath, config);
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
        await using snapshots = createConfigPreflightSnapshotReader();
        await snapshots.read({
          purpose: "doctor",
          allowCurrentPluginMetadata: false,
          includePluginMetadata: true,
          skipPluginValidation: false,
          observe: false,
        });
        expect(await fs.readFile(marker, "utf8")).toBe("loaded");
      }
    }),
);
