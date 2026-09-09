import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { guardUpdateDoctorSchemaUpgrade } from "../commands/doctor-update-schema-guard.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import {
  preflightOpenClawDatabaseSchemas,
  preflightOpenClawStateDatabasePath,
} from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const now = Date.parse("2026-09-07T12:00:00Z");
const graceMs = 5 * 60_000;
const abandonedMs = 30 * 60_000;
const runId = "ed099411-cfbd-4304-a6b7-d3e504a48505";
const secondRunId = "dc43feae-aab9-4f85-9686-89f6c1fe3c12";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function seedRun(db: DatabaseSync, version = "2026.9.2", id = runId) {
  db.prepare(`
    INSERT INTO update_runs (
      run_id, created_at_ms, updated_at_ms, trigger, phase, status,
      origin_json, target_json, before_json, after_json, steps_json, verification_json, repair_json
    ) VALUES (?, ?, ?, 'cli', 'verifying', 'running', '{}', '{}', ?, '{}', '[]', '{}', '[]')
  `).run(id, now - 60_000, now, JSON.stringify({ version }));
}

function createV15Database(version: string | null = "2026.9.2") {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-schema-publication-") } };
  const databasePath = openOpenClawStateDatabase(options).path;
  if (version !== null) {
    createUpdateRun({ runId, trigger: "cli", before: { version } }, options);
  }
  closeOpenClawStateDatabaseForTest();
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      ALTER TABLE skill_workshop_proposals ADD COLUMN workspace_dir TEXT NOT NULL DEFAULT '';
      ALTER TABLE skill_workshop_proposals ADD COLUMN claim_released_time INTEGER;
      DROP TABLE skill_workshop_collection_reviews;
      CREATE TABLE skill_workshop_collection_reviews (
        review_id TEXT NOT NULL PRIMARY KEY,
        workspace_dir TEXT NOT NULL,
        backup_id TEXT NOT NULL,
        create_time INTEGER NOT NULL,
        kept_names_json TEXT NOT NULL,
        written_names_json TEXT NOT NULL,
        dropped_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time
        ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC);
      INSERT INTO skill_workshop_proposals (
        proposal_id, record_json, owner_agent_id, workspace_dir, kind, status,
        created_at, updated_at, draft_hash, claim_released_time
      ) VALUES ('released', '{"id":"released","status":"applied"}', 'main', '/fixture/workspace',
        'create', 'applied', '2026-09-01', '2026-09-01', 'fixture-hash', 1);
      INSERT INTO skill_workshop_collection_reviews VALUES (
        'review', '/fixture/workspace', 'backup', 1, '[]', '[]', '[]'
      );
      PRAGMA user_version = 15;
      UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';
    `);
  } finally {
    db.close();
  }
  return { options, databasePath };
}

function expectVersion(db: DatabaseSync, version: number) {
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
  expect(
    db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  ).toEqual({ schema_version: version });
}

function finishRun(db: DatabaseSync, finishedAtMs: number, id = runId) {
  db.prepare(`
    UPDATE update_runs SET status = 'succeeded', phase = 'finished',
      finished_at_ms = ?, updated_at_ms = ? WHERE run_id = ?
  `).run(finishedAtMs, now, id);
}

function reopen(options: Parameters<typeof openOpenClawStateDatabase>[0]) {
  closeOpenClawStateDatabaseForTest();
  return openOpenClawStateDatabase(options).db;
}

describe("shared state schema publication", () => {
  it.each(["content-v16", "published-v16"] as const)(
    "repairs legacy Workshop columns with a %s marker atomically",
    async (marker) => {
      const { options, databasePath } = createV15Database();
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(`
        CREATE INDEX fixture_review_backup ON skill_workshop_collection_reviews(backup_id);
        INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '16', 1);
      `);
      if (marker === "published-v16") {
        legacy.exec("PRAGMA user_version = 16; UPDATE schema_meta SET schema_version = 16;");
      }
      legacy.close();

      const preflight = await preflightOpenClawStateDatabasePath(databasePath);
      expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      expect(preflight).toMatchObject({ status: "migration-required", requiresWrite: true });
      const repaired = openOpenClawStateDatabase(options).db;
      expect(
        repaired
          .prepare("SELECT owner_agent_id, backup_id FROM skill_workshop_collection_reviews")
          .all(),
      ).toEqual([{ owner_agent_id: "main", backup_id: "backup" }]);
      expect(
        repaired.prepare("SELECT proposal_id, status FROM skill_workshop_proposals").all(),
      ).toEqual([{ proposal_id: "released", status: "stale" }]);
      expect(
        repaired
          .prepare("SELECT sql FROM sqlite_schema WHERE name = 'fixture_review_backup'")
          .get(),
      ).toEqual({
        sql: "CREATE INDEX fixture_review_backup ON skill_workshop_collection_reviews(backup_id)",
      });
      expect(
        repaired
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE name = 'idx_skill_workshop_collection_reviews_workspace_time'",
          )
          .get(),
      ).toBeUndefined();
      const rows = repaired.prepare("SELECT * FROM skill_workshop_proposals").all();
      closeOpenClawStateDatabaseForTest();
      expect(repairOpenClawStateDatabaseSchema(options)).toEqual({ changes: [], warnings: [] });
      expect(
        openOpenClawStateDatabase(options)
          .db.prepare("SELECT * FROM skill_workshop_proposals")
          .all(),
      ).toEqual(rows);
      closeOpenClawStateDatabaseForTest();
      await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toMatchObject({
        status: "exact",
        issues: [],
      });
    },
  );

  it.each(["content-v16", "published-v16"] as const)(
    "routes a %s Workshop split through update preflight to Doctor",
    async (marker) => {
      const { options, databasePath } = createV15Database();
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(
        "INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '16', 1);",
      );
      if (marker === "published-v16") {
        legacy.exec("PRAGMA user_version = 16; UPDATE schema_meta SET schema_version = 16;");
      }
      legacy.close();
      const preflight = await preflightOpenClawDatabaseSchemas({
        env: options.env,
        scope: "state",
        supportedVersions: { state: 16, agent: 19 },
        requireStartupMigrationReadiness: true,
      });
      expect(preflight).toMatchObject({
        incompatible: [],
        indeterminate: [],
        pendingMigrations: [
          {
            kind: "state",
            path: databasePath,
            foundVersion: marker === "published-v16" ? 16 : 15,
            supportedVersion: 16,
          },
        ],
      });
      expect(preflight.deferredSchemaPublications).toBeUndefined();
      vi.stubEnv("OPENCLAW_STATE_DIR", options.env.OPENCLAW_STATE_DIR);
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      await expect(
        guardUpdateDoctorSchemaUpgrade({ schemas: preflight, runtime }),
      ).resolves.toBeUndefined();
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );

  it.each(["workspace_dir", "claim_released_time"] as const)(
    "repairs a published v16 proposal-only leftover %s on cold open",
    async (column) => {
      const { options, databasePath } = createV15Database();
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(`
        DROP TABLE skill_workshop_collection_reviews;
        CREATE TABLE skill_workshop_collection_reviews (
          review_id TEXT NOT NULL PRIMARY KEY, owner_agent_id TEXT NOT NULL,
          backup_id TEXT NOT NULL, create_time INTEGER NOT NULL,
          kept_names_json TEXT NOT NULL, written_names_json TEXT NOT NULL, dropped_json TEXT NOT NULL
        ) STRICT;
        INSERT INTO skill_workshop_collection_reviews VALUES ('review', 'main', 'backup', 1, '[]', '[]', '[]');
        CREATE INDEX idx_skill_workshop_collection_reviews_owner_time
          ON skill_workshop_collection_reviews(owner_agent_id, create_time DESC, review_id);
        ALTER TABLE skill_workshop_proposals DROP COLUMN ${column === "workspace_dir" ? "claim_released_time" : "workspace_dir"};
        PRAGMA user_version = 16;
        UPDATE schema_meta SET schema_version = 16;
      `);
      legacy.close();
      await expect(preflightOpenClawStateDatabasePath(databasePath)).resolves.toMatchObject({
        status: "migration-required",
      });
      const repaired = openOpenClawStateDatabase(options).db;
      expect(repaired.prepare("PRAGMA table_info(skill_workshop_proposals)").all()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: column })]),
      );
      expect(
        repaired.prepare("SELECT proposal_id, status FROM skill_workshop_proposals").all(),
      ).toEqual([
        { proposal_id: "released", status: column === "claim_released_time" ? "stale" : "applied" },
      ]);
      expect(
        repaired
          .prepare("SELECT owner_agent_id, backup_id FROM skill_workshop_collection_reviews")
          .all(),
      ).toEqual([{ owner_agent_id: "main", backup_id: "backup" }]);
    },
  );

  it.each([
    "missing review column",
    "missing attribution mapping",
    "retired-column index",
    "review constraint",
    "future version",
  ] as const)("preserves Workshop state when marker repair refuses %s", (damage) => {
    const { options, databasePath } = createV15Database(null);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("PRAGMA user_version = 16; UPDATE schema_meta SET schema_version = 16;");
    if (damage === "missing review column") {
      legacy.exec("ALTER TABLE skill_workshop_collection_reviews DROP COLUMN backup_id;");
    } else if (damage === "missing attribution mapping") {
      legacy.exec("ALTER TABLE skill_workshop_proposals DROP COLUMN workspace_dir;");
    } else if (damage === "retired-column index") {
      legacy.exec(
        "CREATE INDEX fixture_workspace ON skill_workshop_collection_reviews(workspace_dir);",
      );
    } else if (damage === "review constraint") {
      legacy.exec(`
          DROP TABLE skill_workshop_collection_reviews;
          CREATE TABLE skill_workshop_collection_reviews (
            review_id TEXT NOT NULL PRIMARY KEY, workspace_dir TEXT NOT NULL,
            backup_id TEXT NOT NULL UNIQUE, create_time INTEGER NOT NULL,
            kept_names_json TEXT NOT NULL, written_names_json TEXT NOT NULL, dropped_json TEXT NOT NULL
          ) STRICT;
          INSERT INTO skill_workshop_collection_reviews VALUES ('review', '/fixture/workspace', 'backup', 1, '[]', '[]', '[]');
        `);
    } else {
      legacy.exec(
        "INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '17', 1);",
      );
    }
    const schema = legacy.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
    const proposals = legacy.prepare("SELECT * FROM skill_workshop_proposals").all();
    const reviews = legacy.prepare("SELECT * FROM skill_workshop_collection_reviews").all();
    legacy.close();
    const result = repairOpenClawStateDatabaseSchema(options);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(after.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(
        schema,
      );
      expect(after.prepare("SELECT * FROM skill_workshop_proposals").all()).toEqual(proposals);
      expect(after.prepare("SELECT * FROM skill_workshop_collection_reviews").all()).toEqual(
        reviews,
      );
      expectVersion(after, 16);
    } finally {
      after.close();
    }
  });

  it.each(["runtime open", "doctor repair"] as const)(
    "%s applies v16 content while preserving the unfenced updater's v15 floor",
    (entry) => {
      const { options } = createV15Database();
      if (entry === "doctor repair") {
        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      }
      const db = openOpenClawStateDatabase(options).db;
      expectVersion(db, 15);
      expect(
        db
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
          )
          .get(),
      ).toEqual({ value_json: String(OPENCLAW_STATE_SCHEMA_VERSION) });
      expect(
        db
          .prepare(
            "SELECT owner_agent_id, backup_id FROM skill_workshop_collection_reviews WHERE review_id = 'review'",
          )
          .get(),
      ).toEqual({ owner_agent_id: "main", backup_id: "backup" });
      expect(
        db
          .prepare("SELECT status FROM skill_workshop_proposals WHERE proposal_id = 'released'")
          .get(),
      ).toEqual({ status: "stale" });
      expect(db.prepare("PRAGMA table_info(skill_workshop_proposals)").all()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "claim_released_time" })]),
      );
    },
  );

  it("preserves migrated Workshop rows and skips content on repeated deferred opens and repair", () => {
    const { options } = createV15Database();
    const db = openOpenClawStateDatabase(options).db;
    const proposal = db.prepare("SELECT * FROM skill_workshop_proposals").all();
    db.exec(`INSERT INTO skill_workshop_collection_reviews VALUES (
      'created-after-migration', 'other-agent', 'new-backup', 2, '[]', '[]', '[]'
    )`);
    const reviews = db
      .prepare("SELECT * FROM skill_workshop_collection_reviews ORDER BY review_id")
      .all();
    vi.setSystemTime(now + 60_000);
    expectVersion(reopen(options), 15);
    closeOpenClawStateDatabaseForTest();
    const repair = repairOpenClawStateDatabaseSchema(options);
    expect(repair.warnings).toEqual([]);
    expect(repair.changes).not.toContain(
      "Moved Skill Workshop ownership to per-agent directories (v16)",
    );
    const after = openOpenClawStateDatabase(options).db;
    expectVersion(after, 15);
    expect(after.prepare("SELECT * FROM skill_workshop_proposals").all()).toEqual(proposal);
    expect(
      after.prepare("SELECT * FROM skill_workshop_collection_reviews ORDER BY review_id").all(),
    ).toEqual(reviews);
  });

  it.each([
    { description: "terminal row's finish", terminal: true, duration: graceMs },
    { description: "running row's last update", terminal: false, duration: abandonedMs + 1 },
  ])("publishes only at the deadline anchored to the $description", ({ terminal, duration }) => {
    const { options } = createV15Database();
    const db = openOpenClawStateDatabase(options).db;
    if (terminal) {
      finishRun(db, now);
    }
    vi.setSystemTime(now + duration - 1);
    expectVersion(reopen(options), 15);
    vi.setSystemTime(now + duration);
    expectVersion(openOpenClawStateDatabase(options).db, OPENCLAW_STATE_SCHEMA_VERSION);
  });

  it("uses finished_at_ms even when a terminal record was enriched more recently", () => {
    const { options } = createV15Database();
    finishRun(openOpenClawStateDatabase(options).db, now - graceMs);
    expectVersion(reopen(options), OPENCLAW_STATE_SCHEMA_VERSION);
  });

  it("publishes deferred content when its legacy ledger row is absent", () => {
    const { options } = createV15Database();
    openOpenClawStateDatabase(options).db.exec("DELETE FROM update_runs");
    expectVersion(reopen(options), OPENCLAW_STATE_SCHEMA_VERSION);
  });

  it("requires every legacy row to clear its own deadline, including a new running update", () => {
    const { options } = createV15Database();
    let db = openOpenClawStateDatabase(options).db;
    finishRun(db, now - graceMs);
    seedRun(db, "2026.9.2-1", secondRunId);
    expectVersion((db = reopen(options)), 15);
    finishRun(db, now, secondRunId);
    vi.setSystemTime(now + graceMs - 1);
    expectVersion(reopen(options), 15);
    vi.setSystemTime(now + graceMs);
    expectVersion(reopen(options), OPENCLAW_STATE_SCHEMA_VERSION);
  });

  it.each(["2026.9.1", "2026.9.3", "2026.9.4", null])(
    "publishes immediately for driver %s without creating a deferred marker",
    (version) => {
      const { options } = createV15Database(version);
      const db = openOpenClawStateDatabase(options).db;
      expectVersion(db, OPENCLAW_STATE_SCHEMA_VERSION);
      expect(
        db
          .prepare(
            "SELECT 1 FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
          )
          .get(),
      ).toBeUndefined();
    },
  );

  it.each(["missing metadata", "invalid content"] as const)(
    "retains the typed manual-update fallback and rolls back on %s",
    (failure) => {
      const { options, databasePath } = createV15Database();
      const before = new DatabaseSync(databasePath);
      try {
        if (failure === "missing metadata") {
          before.exec("DROP TABLE config_machine_state");
        } else {
          before.exec(
            "UPDATE skill_workshop_proposals SET record_json = '{' WHERE proposal_id = 'released'",
          );
        }
      } finally {
        before.close();
      }
      expect(() => openOpenClawStateDatabase(options)).toThrow(
        expect.objectContaining({
          name: "UpdateSchemaRefusalError",
        }),
      );
      const after = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expectVersion(after, 15);
        expect(
          after.prepare("SELECT workspace_dir FROM skill_workshop_collection_reviews").get(),
        ).toEqual({ workspace_dir: "/fixture/workspace" });
        expect(
          after.prepare("SELECT status, claim_released_time FROM skill_workshop_proposals").get(),
        ).toEqual({ status: "applied", claim_released_time: 1 });
        if (failure === "missing metadata") {
          expect(
            after.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'config_machine_state'").get(),
          ).toBeUndefined();
        } else {
          expect(
            after
              .prepare(
                "SELECT 1 FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
              )
              .get(),
          ).toBeUndefined();
        }
      } finally {
        after.close();
      }
    },
  );
});
