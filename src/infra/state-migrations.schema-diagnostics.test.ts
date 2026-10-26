import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
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
import { createStateSchemaMigrationStep } from "./state-migrations.state-schema.js";
import { createUpdateFailureFact } from "./update-failure-facts.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

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
