import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { resolveDeferredPluginMigrationConfigPaths } from "../config/deferred-plugin-migration-config.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { readBundledDiscoveryMode } from "../plugins/bundled-discovery-state.js";
import { readPersistedInstalledPluginIndexRowSync } from "../plugins/installed-plugin-index-record-state.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { readAdmittedConfigSnapshot } from "./config-preflight-snapshot.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

it("reads discovery policy and index from one generation, then releases it before readiness guards", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw");
    const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } }),
    );
    const options = { env: process.env };
    const { path: databasePath } = openOpenClawStateDatabase(options);
    closeOpenClawStateDatabaseForTest();
    const writer = new DatabaseSync(databasePath);
    const family = () =>
      ["", "-wal", "-shm"].map((suffix) => {
        const pathname = databasePath + suffix;
        return fs.existsSync(pathname) ? fs.readFileSync(pathname) : null;
      });
    const readIndex = () =>
      readPersistedInstalledPluginIndexRowSync({ env: process.env })?.value_json;
    try {
      const insert = writer.prepare(
        "INSERT INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES (?, ?, 1)",
      );
      insert.run("plugins.bundledDiscovery", '"compat"');
      insert.run("plugins.installedIndex", '{"generation":"before"}');
      const before = family();
      let afterWrite: ReturnType<typeof family> | undefined;
      const result = await readAdmittedConfigSnapshot({
        env: process.env,
        readSnapshot: async () => {
          const snapshot = await readConfigFileSnapshot({
            observe: false,
            pluginValidation: "core-only",
          });
          expect(readBundledDiscoveryMode(options)).toBe("compat");
          expect(family()).toEqual(before);
          // A different owner commits between the two metadata reads.
          writer.exec(
            `BEGIN;
             UPDATE config_machine_state SET value_json = '"allowlist"' WHERE state_key = 'plugins.bundledDiscovery';
             UPDATE config_machine_state SET value_json = '{"generation":"after"}' WHERE state_key = 'plugins.installedIndex';
             COMMIT;`,
          );
          afterWrite = family();
          expect(readIndex()).toBe('{"generation":"before"}');
          expect(family()).toEqual(afterWrite);
          return { snapshot };
        },
        beforeStatePreparation: async () => {
          expect(readBundledDiscoveryMode(options)).toBe("allowlist");
          expect(readIndex()).toBe('{"generation":"after"}');
          return true;
        },
      });
      expect(result.snapshot.valid).toBe(true);
      expect(family()).toEqual(afterWrite);
    } finally {
      writer.close();
      closeOpenClawStateDatabaseForTest();
    }
  });
});

it("refuses a session-store change between core admission and the full config read", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw");
    const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const config = { gateway: { mode: "local" }, plugins: { enabled: false } };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const legacyStore = path.join(home, "other", "sessions.json");
    fs.mkdirSync(path.dirname(legacyStore));
    fs.writeFileSync(legacyStore, "{}\n");
    const changedConfig = JSON.stringify({ ...config, session: { store: legacyStore } });

    await expect(
      readAdmittedConfigSnapshot({
        env: process.env,
        readSnapshot: async () => {
          // Simulate an operator edit while the asynchronous admission read is in flight.
          fs.writeFileSync(configPath, changedConfig);
          return {
            snapshot: await readConfigFileSnapshot({ observe: false }),
          };
        },
      }),
    ).rejects.toMatchObject({ code: 78, message: expect.stringContaining("inputs changed") });
    expect(fs.readFileSync(configPath, "utf8")).toBe(changedConfig);
    expect(fs.readFileSync(legacyStore, "utf8")).toBe("{}\n");
    expect(fs.existsSync(path.join(stateDir, "state"))).toBe(false);
  });
});

it.each([false, true])(
  "preserves pending-plugin inputs (legacy identity: %s)",
  async (legacyIdentity) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw");
      const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const source = {
        gateway: { mode: "local", port: 18991 },
        plugins: { entries: { canvas: { enabled: true } } },
        canvasHost: { enabled: true, root: path.join(home, "legacy-canvas") },
      };
      const activeRaw = `${JSON.stringify(source, null, 2)}\n`;
      const backupRaw = JSON.stringify({
        gateway: { mode: "local", port: 18789 },
        plugins: { enabled: false },
      });
      fs.writeFileSync(configPath, activeRaw);
      fs.writeFileSync(`${configPath}.bak`, backupRaw);
      const initial = await readConfigFileSnapshot({
        observe: false,
        pluginValidation: "core-only",
      });
      expect(initial.valid).toBe(false);

      await recordDeferredPluginMigrations({
        env: process.env,
        pending: [
          {
            pluginId: "canvas",
            reason: "The configured plugin is not installed.",
            command: "openclaw doctor --fix",
            ...resolveDeferredPluginMigrationConfigPaths({
              config: initial.sourceConfig,
              pluginId: "canvas",
              compatibilityMigrationPaths: ["canvasHost"],
            }),
          },
        ],
        resolvedPluginIds: [],
      });
      expect((await readConfigFileSnapshot({ observe: false })).valid).toBe(true);
      await closeOpenClawStateDatabaseAsync();
      const identityPath = path.join(stateDir, "identity", "device.json");
      const identityRaw = '{"retiredIdentity":"leave for Doctor"}\n';
      if (legacyIdentity) {
        fs.mkdirSync(path.dirname(identityPath), { recursive: true });
        fs.writeFileSync(identityPath, identityRaw);
      }
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const databaseFamily = () =>
        ["", "-wal", "-shm"].map((suffix) => {
          const pathname = databasePath + suffix;
          return fs.existsSync(pathname) ? fs.readFileSync(pathname) : null;
        });
      const before = databaseFamily();
      if (legacyIdentity) {
        await expect(
          runStartupConfigPreflight({ gateway: true, observe: false }),
        ).rejects.toMatchObject({
          code: 78,
          message: expect.stringContaining("Legacy device identity exists"),
        });
        expect(fs.readFileSync(identityPath, "utf8")).toBe(identityRaw);
      } else {
        const result = await readAdmittedConfigSnapshot({
          env: process.env,
          readSnapshot: async () => ({
            snapshot: await readConfigFileSnapshot({ observe: false }),
          }),
        });
        expect(result.recovery).toBeUndefined();
        expect(result.snapshot.valid).toBe(true);
        expect(result.snapshot.hash).toBe(initial.hash);
        expect(result.snapshot.raw).toBe(activeRaw);
        expect(result.snapshot.sourceConfig).toMatchObject(source);
        expect(result.snapshot.config.gateway?.port).toBe(18991);
        expect(result.snapshot.config).not.toHaveProperty("canvasHost");
      }
      expect(fs.readFileSync(configPath, "utf8")).toBe(activeRaw);
      expect(fs.readFileSync(`${configPath}.bak`, "utf8")).toBe(backupRaw);
      expect(databaseFamily()).toEqual(before);
    });
  },
);
