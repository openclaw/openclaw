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
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`PRAGMA foreign_keys=OFF; ${sql}`);
  } finally {
    database.close();
  }
}

it("recovers orphan delivery before plugin preparation reads current state", async () => {
  await withPreparedState(async (databasePath) => {
    let injected = false;
    await runDoctorConfigPreflight({
      ...repairOptions,
      measure: async (name, run) => {
        if (!injected && name === "doctor.config-preflight.state-schema") {
          await damageState(
            databasePath,
            "INSERT INTO task_delivery_state(task_id) VALUES('missing-task')",
          );
          injected = true;
        }
        return await run();
      },
    });
    expect(injected).toBe(true);
    const { db } = openOpenClawStateDatabase();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db
        .prepare("SELECT id FROM migration_runs WHERE id = ? AND status = 'pending'")
        .get("deferred-plugin-migration:missing-preparation-fixture"),
    ).toEqual({ id: "deferred-plugin-migration:missing-preparation-fixture" });
  });
});

it("preserves plugin obligations when integrity fails after current-schema preparation", async () => {
  await withPreparedState(async (databasePath) => {
    const repair = vi.spyOn(stateRepair, "repairStateSchema");
    let injected = false;
    await expect(
      runDoctorConfigPreflight({
        ...repairOptions,
        measure: async (name, run) => {
          if (!injected && name === "doctor.config-preflight.legacy-state-migrations") {
            expect(repair).not.toHaveBeenCalled();
            await damageState(
              databasePath,
              `INSERT INTO workspace_generated_bootstrap_hashes
            (workspace_key,filename,sha256) VALUES('missing-workspace','fixture.md','fixture-hash')`,
            );
            injected = true;
          }
          return await run();
        },
      }),
    ).rejects.toThrow(/foreign_key_check|state migration refused/);
    expect(injected).toBe(true);
    expect(repair).toHaveBeenCalledExactlyOnceWith(databasePath, process.env, "doctor");
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
          .prepare(
            "SELECT id FROM migration_runs WHERE id LIKE 'deferred-plugin-migration:%' AND status='pending'",
          )
          .all(),
      ).toEqual([{ id: "deferred-plugin-migration:missing-preparation-fixture" }]);
    } finally {
      inspected.close();
    }
  });
});
