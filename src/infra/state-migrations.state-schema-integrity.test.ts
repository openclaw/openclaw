// Proves Doctor's full integrity request reaches the state-schema migration step.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawStateDatabaseForTest,
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
import { resetAutoMigrateLegacyStateDirForTest } from "./state-migrations.state-dir.js";

const tempDirs = createTrackedTempDirs();
const probeIndex = "sqlite_autoindex_migration_probe_1";

function writeProbeTable(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE migration_probe (
        id INTEGER PRIMARY KEY,
        probe_key TEXT UNIQUE
      );
      INSERT INTO migration_probe(probe_key) VALUES ('alpha'), ('bravo'), ('omega');
    `);
  } finally {
    database.close();
  }
}

function readIntegrityCheck(databasePath: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: unknown }
      | undefined;
    return String(row?.integrity_check);
  } finally {
    database.close();
  }
}

async function prepareFixture(options: { corruptIndex: boolean }) {
  const root = await tempDirs.make("openclaw-state-schema-integrity-");
  const fixture = createCallerModeExecutionFixture(root);
  openOpenClawStateDatabase({ env: fixture.env });
  closeOpenClawStateDatabaseForTest();

  const databasePath = resolveOpenClawStateSqlitePath(fixture.env);
  writeProbeTable(databasePath);
  if (options.corruptIndex) {
    corruptSqliteIndexKey(databasePath, probeIndex, "alpha", "alphi");
  }
  return { fixture, databasePath };
}

async function runFullMigration(fixture: Awaited<ReturnType<typeof prepareFixture>>["fixture"]) {
  const detected = await detectLegacyStateMigrations({
    cfg: {},
    env: fixture.env,
    homedir: () => fixture.homeDir,
    doctorOnlyStateMigrations: true,
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  });
  return runLegacyStateMigrations({
    detected,
    config: {},
    env: fixture.env,
    integrityCheck: "full",
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  });
}

afterEach(async () => {
  resetAutoMigrateLegacyStateDirForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("state-schema migration integrity forwarding", () => {
  it("runs the full integrity check requested by runLegacyStateMigrations", async () => {
    const { fixture, databasePath } = await prepareFixture({ corruptIndex: true });
    expect(readIntegrityCheck(databasePath)).toContain(`row 1 missing from index ${probeIndex}`);

    const result = await runFullMigration(fixture);

    const stateSchemaReceipt = result.stepReceipts.find((receipt) => receipt.id === "state-schema");
    expect(stateSchemaReceipt?.outcome).toBe("completed");
    expect(stateSchemaReceipt?.changes ?? []).toContainEqual(
      expect.stringContaining(`Rebuilt corrupt shared-state SQLite indexes: ${probeIndex}`),
    );
    expect(readIntegrityCheck(databasePath)).toBe("ok");
  });

  it("leaves a clean database untouched during the full check", async () => {
    const { fixture, databasePath } = await prepareFixture({ corruptIndex: false });
    expect(readIntegrityCheck(databasePath)).toBe("ok");

    const result = await runFullMigration(fixture);

    const stateSchemaReceipt = result.stepReceipts.find((receipt) => receipt.id === "state-schema");
    expect(
      (stateSchemaReceipt?.changes ?? []).filter((change) => change.includes("Rebuilt corrupt")),
    ).toEqual([]);
    expect(readIntegrityCheck(databasePath)).toBe("ok");
  });
});
