import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { corruptSqliteIndexKey } from "./sqlite-index-corruption.test-support.js";
import { createCallerModeExecutionFixture } from "./state-migrations.caller-mode.test-helpers.js";
import {
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
} from "./state-migrations.doctor.js";

const directories = createTrackedTempDirs();

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  await directories.cleanup();
});

it("repairs an index/table mismatch when Doctor requests full migration integrity", async () => {
  const fixture = createCallerModeExecutionFixture(await directories.make("doctor-integrity-"));
  // Core schema repair needs no bundled plugin discovery or migrations.
  fixture.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
  openOpenClawStateDatabase({ env: fixture.env });
  await closeOpenClawStateDatabaseAsync();
  const pathname = resolveOpenClawStateSqlitePath(fixture.env);
  {
    using database = new DatabaseSync(pathname);
    database.exec(`
      CREATE TABLE retained_payload (value TEXT);
      CREATE INDEX retained_payload_value ON retained_payload(value);
      INSERT INTO retained_payload VALUES ('original');
    `);
  }
  corruptSqliteIndexKey(pathname, "retained_payload_value", "original", "modified");
  {
    using database = new DatabaseSync(pathname, { readOnly: true });
    expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toContain(
      "missing from index retained_payload_value",
    );
  }

  const detected = await detectLegacyStateMigrations({
    cfg: {},
    env: fixture.env,
    homedir: () => fixture.homeDir,
    doctorOnlyStateMigrations: true,
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  });
  const result = await runLegacyStateMigrations({
    detected,
    env: fixture.env,
    integrityCheck: "full",
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  });
  await closeOpenClawStateDatabaseAsync();

  expect(result.stepReceipts.find((receipt) => receipt.id === "state-schema")).toMatchObject({
    outcome: "completed",
    warnings: [],
  });
  using database = new DatabaseSync(pathname, { readOnly: true });
  expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(database.prepare("SELECT value FROM retained_payload NOT INDEXED").all()).toEqual([
    { value: "original" },
  ]);
  expect(
    database.prepare("SELECT value FROM retained_payload INDEXED BY retained_payload_value").all(),
  ).toEqual([{ value: "original" }]);
});
