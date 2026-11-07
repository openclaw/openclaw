import { chmodSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readPersistedQuarantineRow,
  seedOpenClawDatabaseQuarantine,
} from "../state/openclaw-quarantine-store.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  CRON_DEFAULT_STORE_IDENTITY_SCHEMA_VERSION,
  readCronDefaultStoreKeyInDatabase,
} from "../state/openclaw-state-db-cron-identity-migration.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withStateMigrationBackupForTest } from "../state/openclaw-state-schema.test-support.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { formatSchemaMigrationFailure } from "./schema-migration-diagnostics.js";
import {
  createLegacyStateMigrationStepReceipt,
  DoctorStateMigrationRefusalError,
  logStateMigrationResult,
} from "./state-migrations.messages.js";
import { autoMigrateLegacyPluginDoctorState } from "./state-migrations.plugin-doctor.js";
import { createStateSchemaMigrationStep } from "./state-migrations.state-schema.js";
import { createUpdateFailureFact } from "./update-failure-facts.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseAsync());

it.each(
  (
    ["automatic", "doctor-preparation", "doctor", "plugin-automatic", "plugin-doctor"] as const
  ).flatMap((mode) =>
    (["config", "state", "homedir"] as const).map((selection) => ({ mode, selection })),
  ),
)(
  "preserves launch selector precedence in $mode with $selection selection",
  async ({ mode, selection }) => {
    const root = directories.make("schema-cron-selection-");
    const stateDir = path.join(root, ".openclaw");
    const pathname = path.join(stateDir, "state", "openclaw.sqlite");
    const configPath = path.join(root, "external", "openclaw.json");
    const env =
      selection === "homedir"
        ? {}
        : {
            HOME: root,
            OPENCLAW_CONFIG_PATH: configPath,
            ...(selection === "state" ? { OPENCLAW_STATE_DIR: stateDir } : {}),
          };
    const physicalEnv = { ...env, OPENCLAW_STATE_DIR: stateDir };
    const options = { path: pathname, env: physicalEnv };
    openOpenClawStateDatabase(options);
    await closeOpenClawStateDatabaseAsync();
    const physicalKey = path.join(stateDir, "cron", "jobs.json");
    const configKey = path.join(path.dirname(configPath), "cron", "jobs.json");
    const before = (() => {
      using db = openNodeSqliteDatabase(pathname);
      const previousVersion = CRON_DEFAULT_STORE_IDENTITY_SCHEMA_VERSION - 1;
      db.exec(`DELETE FROM config_machine_state WHERE state_key IN
      ('cron.defaultStoreKey', 'state.schema.contentVersion');
      UPDATE schema_meta SET schema_version = ${previousVersion};
      PRAGMA user_version = ${previousVersion};`);
      for (const key of [physicalKey, configKey]) {
        db.prepare(`INSERT INTO cron_job_scratch
        (store_key, job_id, content, revision, updated_at_ms)
        VALUES (?, 'retained', 'preserve this partition', 7, 1)`).run(key);
      }
      return db.prepare("SELECT * FROM cron_job_scratch ORDER BY store_key").all();
    })();
    const quarantined =
      selection === "homedir" && mode !== "automatic" && mode !== "plugin-automatic";
    if (quarantined) {
      seedOpenClawDatabaseQuarantine({
        env: physicalEnv,
        path: pathname,
        kind: "state",
        reason: "Historical fixture quarantine",
      });
    }
    chmodSync(path.dirname(pathname), 0o755);
    const result = await withStateMigrationBackupForTest(options, () =>
      mode === "plugin-automatic" || mode === "plugin-doctor"
        ? autoMigrateLegacyPluginDoctorState({
            config: { plugins: { enabled: false } },
            env,
            homedir: () => root,
            doctorOnlyStateMigrations: mode === "plugin-doctor",
          })
        : createStateSchemaMigrationStep({ stateDir, env, mode, requiredness: "required" }).run(),
    );
    expect(result.warnings).toEqual([]);
    if (quarantined) {
      expect(readPersistedQuarantineRow(pathname, { env: physicalEnv })).toBeUndefined();
    }
    if (process.platform !== "win32") {
      expect(statSync(path.dirname(pathname)).mode & 0o777).toBe(0o700);
    }
    await closeOpenClawStateDatabaseAsync();
    using db = openNodeSqliteDatabase(pathname, { readOnly: true });
    expect(readCronDefaultStoreKeyInDatabase(db)).toBe(
      selection === "config" ? configKey : physicalKey,
    );
    expect(db.prepare("SELECT * FROM cron_job_scratch ORDER BY store_key").all()).toEqual(before);
  },
);

it("keeps the missing shared-state table and recovery advice in Doctor's refusal and log", async () => {
  const root = directories.make("schema-diagnostic-");
  const stateDir = path.join(root, "private state with spaces");
  const pathname = path.join(stateDir, "state", "openclaw.sqlite");
  const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: stateDir };
  openOpenClawStateDatabase({ env });
  await closeOpenClawStateDatabaseAsync();
  {
    using db = openNodeSqliteDatabase(pathname);
    db.exec("DROP TABLE apns_registration_tombstones;");
  }
  const step = createStateSchemaMigrationStep({
    stateDir,
    env,
    mode: "doctor",
    requiredness: "required",
  });
  const result = await withStateMigrationBackupForTest({ env }, () => step.run());
  expect(result.warnings[0]).toContain("missing table apns_registration_tombstones");
  const refusal = new DoctorStateMigrationRefusalError([
    createLegacyStateMigrationStepReceipt(step, result),
  ]);
  expect(refusal.failureFacts).toEqual([
    expect.objectContaining({
      check: "state-schema",
      code: "step-refused",
      message: expect.stringContaining(
        "SqliteSchemaMismatchError: missing table apns_registration_tombstones",
      ),
    }),
  ]);
  expect(refusal.message).toContain('rerun "openclaw doctor --fix" against the same state/config');
  expect(refusal.message).not.toContain(root);

  const logs: string[] = [];
  logStateMigrationResult(result, {
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  });
  expect(logs.join("\n")).toContain("missing table apns_registration_tombstones");
  expect(logs.join("\n")).toContain('rerun "openclaw doctor --fix"');
  {
    using db = openNodeSqliteDatabase(pathname, { readOnly: true });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get("apns_registration_tombstones"),
    ).toBeUndefined();
  }
});

it("preserves a native SQLite constraint code and object through finding redaction", () => {
  using db = openNodeSqliteDatabase(":memory:");
  db.exec(
    "CREATE TABLE migration_rows (id TEXT UNIQUE); INSERT INTO migration_rows VALUES ('row');",
  );
  let failure: unknown;
  try {
    db.exec("INSERT INTO migration_rows VALUES ('row');");
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  const fact = createUpdateFailureFact({
    check: "state-schema",
    code: "step-refused",
    message: formatSchemaMigrationFailure(
      "Failed migrating shared state database schema",
      "/private/database with spaces/openclaw.sqlite",
      failure,
    ),
  });
  expect(fact.message).toContain("code=ERR_SQLITE_ERROR, errcode=2067");
  expect(fact.message).toContain("UNIQUE constraint failed: migration_rows.id");
  expect(fact.message).not.toContain("/private");
});
