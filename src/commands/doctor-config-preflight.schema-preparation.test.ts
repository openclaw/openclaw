import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { writeOpenClawConfig } from "../config/test-helpers.js";
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

async function withPreparedState(run: (databasePath: string) => Promise<void>) {
  await withDoctorConfigPreflightHome(async (home) => {
    const workspace = path.join(home, ".openclaw", "workspace");
    await writeOpenClawConfig(home, {
      gateway: { mode: "local" },
      agents: { ownership: "explicit", defaults: { workspace }, entries: { main: {} } },
      plugins: { entries: { "missing-preparation-fixture": { enabled: true } } },
    });
    fs.mkdirSync(workspace, { recursive: true });
    const databasePath = openOpenClawStateDatabase().path;
    await closeOpenClawStateDatabaseAsync();
    await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, () => run(databasePath));
  });
}

const repairOptions = {
  observe: false,
  invocationPurpose: "doctor",
  repairPrefixedConfig: true,
  doctorOnlyStateMigrations: true,
  preparePluginMetadataSnapshot: true,
} as const;

async function damageState(databasePath: string, sql: string) {
  await closeOpenClawStateDatabaseAsync();
  using database = new DatabaseSync(databasePath);
  database.exec(`PRAGMA foreign_keys=OFF; ${sql}`);
}

it.each([
  ["state-schema", "INSERT INTO task_delivery_state(task_id) VALUES('missing-task')", false],
  [
    "legacy-state-migrations",
    `INSERT INTO workspace_generated_bootstrap_hashes
            (workspace_key,filename,sha256) VALUES('missing-workspace','fixture.md','fixture-hash')`,
    true,
  ],
] as const)("preserves plugin obligations after damage at %s", async (phase, sql, refuses) => {
  await withPreparedState(async (databasePath) => {
    const repair = vi.spyOn(stateRepair, "repairStateSchema");
    let injected = false;
    const operation = runDoctorConfigPreflight({
      ...repairOptions,
      measure: async (name, run) => {
        if (!injected && name === `doctor.config-preflight.${phase}`) {
          if (refuses) {
            expect(repair).not.toHaveBeenCalled();
          }
          await damageState(databasePath, sql);
          injected = true;
        }
        return await run();
      },
    });
    if (refuses) {
      await expect(operation).rejects.toThrow(/foreign_key_check|state migration refused/);
      expect(repair).toHaveBeenCalledOnce();
    } else {
      await operation;
      const { db } = openOpenClawStateDatabase();
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        db
          .prepare("SELECT id FROM migration_runs WHERE id = ? AND status = 'pending'")
          .get("deferred-plugin-migration:missing-preparation-fixture"),
      ).toEqual({ id: "deferred-plugin-migration:missing-preparation-fixture" });
    }
    expect(injected).toBe(true);
    if (!refuses) {
      return;
    }
    using inspected = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspected.prepare("PRAGMA user_version").get()?.user_version).toBe(
      OPENCLAW_STATE_SCHEMA_VERSION,
    );
    expect(
      inspected.prepare("SELECT workspace_key FROM workspace_generated_bootstrap_hashes").all(),
    ).toEqual([{ workspace_key: "missing-workspace" }]);
    expect(
      inspected
        .prepare(
          "SELECT id FROM migration_runs WHERE id LIKE 'deferred-plugin-migration:%' AND status='pending'",
        )
        .all(),
    ).toEqual([{ id: "deferred-plugin-migration:missing-preparation-fixture" }]);
  });
});
