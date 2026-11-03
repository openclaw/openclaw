import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as terminalNotes from "../../packages/terminal-core/src/note.js";
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
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { refreshStartupPluginQuarantine } from "./doctor-config-preflight-plugin-verification.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

async function writeJson(file: string, value: unknown) {
  const bytes = `${JSON.stringify(value)}\n`;
  await fs.writeFile(file, bytes);
  return bytes;
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
    withDoctorConfigPreflightHome((home) =>
      withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
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
        // Stable admits managed npm projects by their published project manifest.
        await writeJson(path.join(managedRoot, "package.json"), {
          private: true,
          dependencies: { "@fixture/managed": "1.0.0" },
        });
        const config = {
          gateway: { mode: "local" as const, auth: { mode: "none" as const } },
          plugins: { allow: Object.keys(packageDirs) },
          meta: { migrations: { webhookListeners: true as const } },
        };
        const configPath = path.join(stateDir, "openclaw.json");
        const configBytes = await writeJson(configPath, config);
        await seedInstalledPluginIndex(records, { config });
        const recordsBefore = await readPersistedInstalledPluginIndexInstallRecordsAsync();

        if (oldRootState === "present") {
          // Update rehearsals keep the old links; their candidate owns the repair.
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
          expect(
            await fs.readlink(path.join(packageDirs.managed, "node_modules", "openclaw")),
          ).toBe(oldRoot);
        }

        const ready = await runStartupConfigPreflight({ gateway: true, observe: false });
        expect(ready.snapshot.valid).toBe(true);
        for (const id of ["managed", "registered"] as const) {
          expect(
            await fs.realpath(path.join(packageDirs[id], "node_modules", "openclaw")),
            `${id}: ${notes.mock.calls.flat().join("\n")}`,
          ).toBe(currentRoot);
        }
        expect(listActiveDegradedPlugins()).toEqual([]);
        expect(notes.mock.calls.flat().join("\n")).toContain(`${oldRoot} -> ${currentRoot}`);
        expect(readStartupMigrationWarning()).toBeUndefined();
        expect(await fs.readlink(path.join(packageDirs.local, "node_modules", "openclaw"))).toBe(
          oldRoot,
        );
        expect(await fs.readFile(configPath, "utf8")).toBe(configBytes);

        const peerLink = path.join(packageDirs.managed, "node_modules", "openclaw");
        const firstLink = await fs.lstat(peerLink);
        notes.mockClear();
        recordStartupMigrationWarnings([]);
        await runStartupConfigPreflight({ gateway: true, observe: false });
        expect(await fs.lstat(peerLink)).toMatchObject({
          ino: firstLink.ino,
          mtimeMs: firstLink.mtimeMs,
        });
        expect(readStartupMigrationWarning()).toBeUndefined();
        expect(notes.mock.calls.flat().join("\n")).not.toContain("Repaired OpenClaw host link");
        expect(await readPersistedInstalledPluginIndexInstallRecordsAsync()).toEqual(recordsBefore);
        expect(await fs.readFile(configPath, "utf8")).toBe(configBytes);
      }),
    ),
);
