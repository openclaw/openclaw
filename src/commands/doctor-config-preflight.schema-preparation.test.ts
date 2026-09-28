import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { prepareLegacyStateDatabaseSchema } from "../infra/state-migrations.doctor.js";
import { createStateSchemaMigrationStep } from "../infra/state-migrations.state-schema.js";
import { recordOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import * as stateRepair from "../state/openclaw-state-db-repair.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupSessionStateForTest();
});

it.each(["current", "historical", "missing index"] as const)(
  "prepares %s shared state without replacing the later full Doctor repair",
  async (shape) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const databasePath = openOpenClawStateDatabase({ env }).path;
      await closeOpenClawStateDatabaseAsync();
      if (shape === "historical") {
        fs.writeFileSync(
          databasePath,
          gunzipSync(fs.readFileSync("test/fixtures/sqlite/openclaw-state-v2026.7.1-2.sqlite.gz")),
        );
      } else if (shape === "missing index") {
        const database = new DatabaseSync(databasePath);
        try {
          database.exec("DROP INDEX idx_audit_events_time");
        } finally {
          database.close();
        }
      }
      const repair = vi.spyOn(stateRepair, "repairStateSchema");
      const prepared = await prepareLegacyStateDatabaseSchema(env);
      expect(prepared.warnings).toEqual([]);
      expect(repair.mock.calls.filter((call) => call[2] === "doctor")).toHaveLength(
        shape === "current" ? 0 : 1,
      );
      const inspected = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(inspected.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_STATE_SCHEMA_VERSION,
        );
        expect(
          inspected
            .prepare("SELECT name FROM sqlite_schema WHERE name = 'config_machine_state'")
            .get(),
        ).toEqual({ name: "config_machine_state" });
        expect(
          inspected
            .prepare("SELECT name FROM sqlite_schema WHERE name = 'idx_audit_events_time'")
            .get(),
        ).toEqual({ name: "idx_audit_events_time" });
      } finally {
        inspected.close();
      }
      repair.mockClear();
      const result = await createStateSchemaMigrationStep({
        stateDir,
        env,
        mode: "doctor",
        requiredness: "conditional",
      }).run();
      expect(result.warnings).toEqual([]);
      expect(repair).toHaveBeenCalledExactlyOnceWith(databasePath, env, "doctor");
    });
  },
);

it.each(["persisted quarantine", "orphan delivery"] as const)(
  "recovers %s before plugin preparation reads current state",
  async (damage) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const workspace = path.join(stateDir, "workspace");
      await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
        agents: { ownership: "explicit", defaults: { workspace }, entries: { main: {} } },
        plugins: { entries: { "missing-preparation-fixture": { enabled: true } } },
      });
      fs.mkdirSync(workspace, { recursive: true });
      const databasePath = openOpenClawStateDatabase().path;
      await closeOpenClawStateDatabaseAsync();
      let injected = false;
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        await runDoctorConfigPreflight({
          observe: false,
          invocationPurpose: "doctor",
          repairPrefixedConfig: true,
          doctorOnlyStateMigrations: true,
          preparePluginMetadataSnapshot: true,
          measure: async (name, run) => {
            if (!injected && name === "doctor.config-preflight.state-schema") {
              await closeOpenClawStateDatabaseAsync();
              if (damage === "persisted quarantine") {
                expect(
                  recordOpenClawDatabaseQuarantine({
                    kind: "state",
                    path: databasePath,
                    reason: "previously detected synthetic damage",
                  }),
                ).toBe(true);
              } else {
                const database = new DatabaseSync(databasePath);
                try {
                  database.exec(`PRAGMA foreign_keys=OFF;
                    INSERT INTO task_delivery_state(task_id)
                    VALUES('missing-task');`);
                } finally {
                  database.close();
                }
              }
              injected = true;
            }
            return await run();
          },
        });
      });
      expect(injected).toBe(true);
      const opened = openOpenClawStateDatabase();
      expect(opened.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        opened.db
          .prepare("SELECT id FROM migration_runs WHERE id = ? AND status = 'pending'")
          .get("deferred-plugin-migration:missing-preparation-fixture"),
      ).toEqual({ id: "deferred-plugin-migration:missing-preparation-fixture" });
    });
  },
);

it.each(["early convergence", "later repair"] as const)(
  "preserves committed plugin obligations when same-version integrity fails before %s",
  async (boundary) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const workspace = path.join(stateDir, "workspace");
      await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
        agents: { ownership: "explicit", defaults: { workspace }, entries: { main: {} } },
        plugins: { entries: { "missing-preparation-fixture": { enabled: true } } },
      });
      fs.mkdirSync(workspace, { recursive: true });
      const databasePath = openOpenClawStateDatabase().path;
      await closeOpenClawStateDatabaseAsync();
      let injected = false;
      const faultStep =
        boundary === "early convergence"
          ? "doctor.config-preflight.plugin-plan"
          : "doctor.config-preflight.legacy-state-migrations";
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        await expect(
          runDoctorConfigPreflight({
            observe: false,
            invocationPurpose: "doctor",
            repairPrefixedConfig: true,
            doctorOnlyStateMigrations: true,
            preparePluginMetadataSnapshot: true,
            measure: async (name, run) => {
              if (!injected && name === faultStep) {
                await closeOpenClawStateDatabaseAsync();
                const database = new DatabaseSync(databasePath);
                try {
                  database.exec(`PRAGMA foreign_keys=OFF;
                  INSERT INTO workspace_generated_bootstrap_hashes
                    (workspace_key,filename,sha256)
                    VALUES('missing-workspace','fixture.md','fixture-hash');`);
                } finally {
                  database.close();
                }
                injected = true;
              }
              return await run();
            },
          }),
        ).rejects.toThrow(/foreign_key_check|state migration refused/);
      });
      expect(injected).toBe(true);
      const inspected = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(inspected.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_STATE_SCHEMA_VERSION,
        );
        expect(
          inspected.prepare("SELECT workspace_key FROM workspace_generated_bootstrap_hashes").all(),
        ).toEqual([{ workspace_key: "missing-workspace" }]);
        expect(
          inspected
            .prepare(`SELECT id FROM migration_runs
          WHERE id LIKE 'deferred-plugin-migration:%' AND status='pending'`)
            .all(),
        ).toEqual(
          boundary === "later repair"
            ? [{ id: "deferred-plugin-migration:missing-preparation-fixture" }]
            : [],
        );
      } finally {
        inspected.close();
      }
    });
  },
);
