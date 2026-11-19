// Agent schema 42 installs session recipient authority as its own versioned step on top of
// upstream's schema 41.
import fs, { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withoutAgentActiveEventFacts } from "./openclaw-agent-active-event-facts-schema.js";
import { withoutAgentColdArchiveChunks } from "./openclaw-agent-cold-archive-chunks-schema.js";
import { withoutAgentColdNavigation } from "./openclaw-agent-cold-navigation-schema.js";
import { withoutAgentCreationOperations } from "./openclaw-agent-creation-operations-schema.js";
import { agentEngineSchema } from "./openclaw-agent-db-engine.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { ensureSessionKeyContractSchemaInTransaction } from "./openclaw-agent-db-schema-helpers.js";
import { migrateSessionRecipientAuthorityInTransaction } from "./openclaw-agent-db-session-migrations.js";
import {
  closeOpenClawAgentDatabasesForTest,
  ensureOpenClawAgentDatabaseSchema,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase as openOpenClawAgentDatabaseRuntime,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "./openclaw-agent-db.test-support.js";
import { withoutSessionRecipientAuthoritySchema } from "./openclaw-agent-recipient-authority-schema.js";
import { materializeV21WorkerAgentDatabase } from "./openclaw-agent-schema-v21.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  assertOpenClawMigrationWitnessPreserved,
  captureOpenClawMigrationWitness,
} from "./openclaw-migration-witness.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const agentDbTempDirs: string[] = [];
let sharedStateDatabaseTemplatePath: string | undefined;

function createTempStateDir(): string {
  return makeTempDir(agentDbTempDirs, "openclaw-agent-db-");
}

function ensureSharedStateDatabaseTemplate(): string {
  if (sharedStateDatabaseTemplatePath) {
    return sharedStateDatabaseTemplatePath;
  }
  const stateDir = makeTempDir(agentDbTempDirs, "openclaw-agent-db-shared-state-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const database = openOpenClawStateDatabase({ env });
  sharedStateDatabaseTemplatePath = database.path;
  closeOpenClawStateDatabaseForTest();
  return sharedStateDatabaseTemplatePath;
}

function materializeSharedStateDatabase(env: NodeJS.ProcessEnv | undefined): void {
  const stateDatabasePath = resolveOpenClawStateSqlitePath(env);
  if (!fs.existsSync(stateDatabasePath)) {
    // Agent schema tests own the per-agent database. Seed the shared registry
    // from one real closed database instead of rebuilding its full schema per case.
    fs.mkdirSync(path.dirname(stateDatabasePath), { recursive: true });
    fs.copyFileSync(ensureSharedStateDatabaseTemplate(), stateDatabasePath);
  }
}

function openOpenClawAgentDatabase(
  options: Parameters<typeof openOpenClawAgentDatabaseRuntime>[0],
) {
  materializeSharedStateDatabase(options.env);
  return openOpenClawAgentDatabaseRuntime(options);
}

async function migrateAndOpenLegacyAgentDatabaseForTest(
  options: Parameters<typeof openOpenClawAgentDatabase>[0],
) {
  // Prepare the unrelated registry before the real maintenance lease's acquisition budget.
  materializeSharedStateDatabase(options.env);
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(pathname);
  try {
    await withAgentDatabaseMaintenanceLease({ env: options?.env }, async () =>
      ensureOpenClawAgentDatabaseSchema(database, options),
    );
  } finally {
    database.close();
  }
  return openOpenClawAgentDatabase(options);
}

/** Release DDL captured from exact upstream commits; never derived from the current schema. */
function readCapturedAgentSchema(name: string): string {
  return readFileSync(new URL(`../../test/fixtures/sqlite/${name}`, import.meta.url), "utf8");
}

const AUTHORITY = {
  sessionKey: "agent:main:retained-authority",
  epoch: "55555555-5555-4555-8555-555555555555",
};

const CAPTURED_SESSION = {
  sessionKey: "agent:main:captured",
  entryJson: JSON.stringify({ sessionId: "captured-session", updatedAt: 1 }),
};

/** Writes a closed agent database from historical DDL plus one settled session row. */
function stageAgentDatabase(env: NodeJS.ProcessEnv, ddl: string, version: number): string {
  materializeSharedStateDatabase(env);
  const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  using database = new DatabaseSync(databasePath);
  database.exec(ddl);
  // A DDL file is schema only; live databases also hold the schema's seed rows.
  database.exec(`PRAGMA user_version = ${version};
    INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
    VALUES ('primary', 'agent', ${version}, 'main', 1, 1);
    INSERT OR IGNORE INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'main', 0);`);
  database
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 1)",
    )
    .run(CAPTURED_SESSION.sessionKey, "captured-session", CAPTURED_SESSION.entryJson);
  database.exec("UPDATE session_nodes SET entry_valid = 1");
  return databasePath;
}

/**
 * Writes a schema-24 file from upstream's captured DDL. Upstream's steps 27–31 rebuild tables,
 * so a current database rolled back to 24 is not a schema 24 ever wrote.
 */
function stageSchema24AgentDatabase(env: NodeJS.ProcessEnv): string {
  return stageAgentDatabase(env, readCapturedAgentSchema("openclaw-agent-schema-v24.sql"), 24);
}

function readSchemaMarkers(handle: EngineConnection) {
  const database = requireNativeSqliteDatabase(handle);
  return {
    userVersion: readSqliteUserVersion(database),
    schemaVersion: database
      .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
      .get()?.schema_version,
  };
}

function hasRecipientAuthorityTable(handle: EngineConnection): boolean {
  return (
    requireNativeSqliteDatabase(handle)
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_recipient_authority'",
      )
      .get() !== undefined
  );
}

afterAll(() => {
  cleanupTempDirs(agentDbTempDirs);
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("openclaw agent database", () => {
  it("upgrades v18 embedded recipient authority without parsing Doctor-owned malformed rows", async () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    // The frozen v21 schema carries no session_recipient_authority table.
    const databasePath = materializeV21WorkerAgentDatabase(stateDir);
    const validKey = "agent:worker-1:valid-authority";
    const malformedKey = "agent:worker-1:malformed-authority";
    const epoch = "11111111-1111-4111-8111-111111111111";
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    removeCanonicalValidationFromHistoricalAgentFixture(legacy);
    legacy.exec(`
      PRAGMA user_version = 18;
      UPDATE schema_meta SET schema_version = 18 WHERE meta_key = 'primary';
    `);
    legacy
      .prepare(
        `INSERT INTO session_nodes (
           session_key, current_session_id, entry_json, entry_valid, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        validKey,
        "valid-session",
        JSON.stringify({
          sessionId: "valid-session",
          updatedAt: 10,
          recipientAuthorityEpoch: epoch,
        }),
        1,
        10,
      );
    legacy
      .prepare(
        `INSERT INTO session_nodes (
           session_key, current_session_id, entry_json, entry_valid, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(malformedKey, "malformed-session", "{malformed", -1, 20);
    legacy
      .prepare("UPDATE session_nodes SET entry_valid = ? WHERE session_key = ?")
      .run(1, validKey);
    legacy
      .prepare("UPDATE session_nodes SET entry_valid = ? WHERE session_key = ?")
      .run(-1, malformedKey);
    legacy.close();

    const migrated = await migrateAndOpenLegacyAgentDatabaseForTest({
      agentId: "worker-1",
      env,
    });

    expect(
      migrated.db
        .prepare(
          "SELECT session_key, entry_json, entry_valid FROM session_nodes WHERE session_key IN (?, ?) ORDER BY session_key",
        )
        .all(malformedKey, validKey),
    ).toEqual([
      { session_key: malformedKey, entry_json: "{malformed", entry_valid: -1 },
      {
        session_key: validKey,
        entry_json: JSON.stringify({ sessionId: "valid-session", updatedAt: 10 }),
        entry_valid: 1,
      },
    ]);
    expect(
      migrated.db
        .prepare("SELECT session_key, epoch FROM session_recipient_authority WHERE session_key = ?")
        .get(validKey),
    ).toEqual({ session_key: validKey, epoch });
  });

  // Upstream freezes its historical PostgreSQL schemas byte for byte; the authority statement must
  // leave with its blank-line separator or every predecessor carries a doubled one.
  it("derives every historical PostgreSQL schema without a doubled separator", () => {
    for (const migration of agentEngineSchema.postgresMigrations ?? []) {
      expect(migration.fromSchema.postgres, `schema ${migration.version - 1}`).not.toContain(
        "\n\n\n",
      );
    }
  });

  // Stores below 42 take lazy additive ensures; none may install recipient authority outside its
  // versioned step (Doctor's v16 repair refuses an unexpected table).
  it("installs only the session-key contract on a store that lacks it", () => {
    using database = openNodeSqliteDatabase(":memory:");
    ensureSessionKeyContractSchemaInTransaction(database);
    expect(
      database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all(),
    ).toEqual([{ name: "session_key_contract" }]);
  });

  it("creates a fresh database at schema 42 with recipient authority", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const { db } = openOpenClawAgentDatabase({ agentId: "main", env });

    expect(OPENCLAW_AGENT_SCHEMA_VERSION).toBe(42);
    expect(readSchemaMarkers(db)).toEqual({ userVersion: 42, schemaVersion: 42 });
    expect(hasRecipientAuthorityTable(db)).toBe(true);
    // Upstream's 40 sits beneath recipient authority.
    expect(
      db
        .prepare("SELECT 1 AS n FROM sqlite_schema WHERE name = 'session_creation_operations'")
        .get(),
    ).toEqual({ n: 1 });
  });

  it("migrates a schema-24 database that lacks recipient authority", async () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const databasePath = stageSchema24AgentDatabase(env);

    // Ordinary runtime opens refuse the older schema; migration is Doctor-owned.
    expect(() => openOpenClawAgentDatabase({ agentId: "main", env })).toThrow(
      /openclaw doctor --fix/u,
    );
    closeOpenClawAgentDatabasesForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const unchanged = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(readSchemaMarkers(unchanged)).toEqual({ userVersion: 24, schemaVersion: 24 });
      expect(hasRecipientAuthorityTable(unchanged)).toBe(false);
    } finally {
      unchanged.close();
    }

    const migrated = await migrateAndOpenLegacyAgentDatabaseForTest({ agentId: "main", env });

    expect(readSchemaMarkers(migrated.db)).toEqual({ userVersion: 42, schemaVersion: 42 });
    expect(
      migrated.db
        .prepare("SELECT name FROM pragma_table_info('session_recipient_authority') ORDER BY cid")
        .all(),
    ).toEqual([
      { name: "session_key" },
      { name: "epoch" },
      { name: "created_at" },
      { name: "updated_at" },
    ]);
    expect(migrated.db.prepare("SELECT * FROM session_recipient_authority").all()).toEqual([]);
    expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  // Upstream's 32-36 and 38 change only PostgreSQL; on SQLite they advance metadata over schema 31
  // (38 over 37). Upstream's 37 adds the cold-archive chunk table, which earlier databases gain on
  // the way, its 39 widens the transcript payload CHECK, its 40 adds creation receipts and its 41
  // the empty active-event-facts companion. Upstream's own 39-41 run from captured DDL below.
  it.each([32, 33, 34, 35, 36, 37, 38])(
    "adds recipient authority to upstream's schema-%i database",
    async (version) => {
      const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
      const priorSchema = withoutAgentColdNavigation(
        withoutAgentCreationOperations(
          withoutAgentActiveEventFacts(
            withoutSessionRecipientAuthoritySchema(OPENCLAW_AGENT_SCHEMA_SQL),
          ),
        ),
      );
      stageAgentDatabase(
        env,
        version < 37 ? withoutAgentColdArchiveChunks(priorSchema) : priorSchema,
        version,
      );

      const migrated = await migrateAndOpenLegacyAgentDatabaseForTest({ agentId: "main", env });

      expect(readSchemaMarkers(migrated.db)).toEqual({ userVersion: 42, schemaVersion: 42 });
      expect(hasRecipientAuthorityTable(migrated.db)).toBe(true);
      expect(migrated.db.prepare("SELECT * FROM session_recipient_authority").all()).toEqual([]);
      expect(migrated.db.prepare("PRAGMA integrity_check").all()).toEqual([
        { integrity_check: "ok" },
      ]);
      expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        migrated.db
          .prepare("SELECT count(*) AS n FROM session_transcript_cold_archive_chunks")
          .get(),
      ).toEqual({ n: 0 });
    },
  );

  // Re-run safety: the step keeps rows when its table exists, imports a legacy epoch once, and
  // never lets a legacy epoch replace existing authority.
  it("applies the schema-42 step twice to a migrated database with one effect", async () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const databasePath = stageAgentDatabase(
      env,
      readCapturedAgentSchema("openclaw-agent-schema-v41.sql"),
      41,
    );
    await migrateAndOpenLegacyAgentDatabaseForTest({ agentId: "main", env });
    closeOpenClawAgentDatabasesForTest();
    const { DatabaseSync } = requireNodeSqlite();
    using database = new DatabaseSync(databasePath);
    database
      .prepare(
        "INSERT INTO session_recipient_authority (session_key, epoch, created_at, updated_at) VALUES (?, ?, 1, 2)",
      )
      .run(AUTHORITY.sessionKey, AUTHORITY.epoch);
    database
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 2)",
      )
      .run(
        "agent:main:late-epoch",
        "late",
        JSON.stringify({
          sessionId: "late",
          updatedAt: 2,
          recipientAuthorityEpoch: "77777777-7777-4777-8777-777777777777",
        }),
      );
    // A legacy epoch for a key that already has authority must not replace it.
    database
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 3)",
      )
      .run(
        AUTHORITY.sessionKey,
        "retained",
        JSON.stringify({
          sessionId: "retained",
          updatedAt: 3,
          recipientAuthorityEpoch: "99999999-9999-4999-8999-999999999999",
        }),
      );
    const read = () => ({
      schema: database
        .prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name")
        .all(),
      authority: database
        .prepare("SELECT * FROM session_recipient_authority ORDER BY session_key")
        .all(),
      sessions: database
        .prepare(
          "SELECT session_key, entry_json, entry_valid FROM session_nodes ORDER BY session_key",
        )
        .all(),
    });
    const apply = () => {
      database.exec("BEGIN IMMEDIATE");
      migrateSessionRecipientAuthorityInTransaction(database);
      database.exec("COMMIT");
    };

    apply();
    const once = read();
    expect(once.authority).toEqual([
      expect.objectContaining({
        session_key: "agent:main:late-epoch",
        epoch: "77777777-7777-4777-8777-777777777777",
      }),
      { session_key: AUTHORITY.sessionKey, epoch: AUTHORITY.epoch, created_at: 1, updated_at: 2 },
    ]);
    expect(
      database
        .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
        .get(AUTHORITY.sessionKey),
    ).toEqual({ entry_json: JSON.stringify({ sessionId: "retained", updatedAt: 3 }) });
    apply();
    expect(read()).toEqual(once);
    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  });

  // Upstream's exact 39, 40 and 41 DDL (test/fixtures/sqlite/README.md): each runs only its own
  // later upstream steps and then the authority step, and the witness keeps every retained row.
  it.each([39, 40, 41])(
    "migrates upstream's captured schema-%i database to 42 through the authority step",
    async (version) => {
      const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
      const databasePath = stageAgentDatabase(
        env,
        readCapturedAgentSchema(`openclaw-agent-schema-v${version}.sql`),
        version,
      );
      const witness = () => {
        const { DatabaseSync } = requireNodeSqlite();
        using database = new DatabaseSync(databasePath, { readOnly: true });
        return captureOpenClawMigrationWitness(database, { role: "agent", agentId: "main" });
      };
      const original = witness();

      const migrated = await migrateAndOpenLegacyAgentDatabaseForTest({ agentId: "main", env });

      expect(readSchemaMarkers(migrated.db)).toEqual({ userVersion: 42, schemaVersion: 42 });
      expect(migrated.db.prepare("SELECT * FROM session_recipient_authority").all()).toEqual([]);
      expect(
        migrated.db
          .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
          .get(CAPTURED_SESSION.sessionKey),
      ).toEqual({ entry_json: CAPTURED_SESSION.entryJson });
      expect(migrated.db.prepare("PRAGMA integrity_check").all()).toEqual([
        { integrity_check: "ok" },
      ]);
      expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      closeOpenClawAgentDatabasesForTest();
      expect(() => assertOpenClawMigrationWitnessPreserved(original, witness())).not.toThrow();
    },
  );

  // A current database crosses no step: the owner re-runs without touching authority or sessions.
  it("leaves a current schema-42 database and its recipient authority unchanged", async () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    openOpenClawAgentDatabase({ agentId: "main", env });
    closeOpenClawAgentDatabasesForTest();
    const { DatabaseSync } = requireNodeSqlite();
    using database = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main", env }));
    database
      .prepare(
        "INSERT INTO session_recipient_authority (session_key, epoch, created_at, updated_at) VALUES (?, ?, 1, 2)",
      )
      .run(AUTHORITY.sessionKey, AUTHORITY.epoch);
    database
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 1)",
      )
      .run(CAPTURED_SESSION.sessionKey, "captured-session", CAPTURED_SESSION.entryJson);
    database.exec("UPDATE session_nodes SET entry_valid = 1");
    const read = () => ({
      markers: readSchemaMarkers(database),
      schema: database
        .prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name")
        .all(),
      authority: database.prepare("SELECT * FROM session_recipient_authority").all(),
      sessions: database
        .prepare("SELECT session_key, entry_json, entry_valid FROM session_nodes")
        .all(),
    });
    const before = read();
    expect(before.markers).toEqual({ userVersion: 42, schemaVersion: 42 });

    await migrateAndOpenLegacyAgentDatabaseForTest({ agentId: "main", env });

    expect(read()).toEqual(before);
  });

  // Recipient authority adds no shape classifier: a marker above the shape its database holds is
  // refused by that version's own upstream schema check, before the authority step or any write.
  it.each([
    {
      shape: "a 39 holding upstream's 38 transcript payload CHECK",
      version: 39,
      ddl: () =>
        withoutAgentColdNavigation(readCapturedAgentSchema("openclaw-agent-schema-v39.sql")),
      refusal: /transcript_events/u,
    },
    {
      shape: "a 41 holding upstream's 40",
      version: 41,
      ddl: () => readCapturedAgentSchema("openclaw-agent-schema-v40.sql"),
      refusal: /session_transcript_active_event_facts/u,
    },
  ])("refuses $shape before any write", async ({ version, ddl, refusal }) => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const databasePath = stageAgentDatabase(env, ddl(), version);
    const read = () => {
      const { DatabaseSync } = requireNodeSqlite();
      using database = new DatabaseSync(databasePath, { readOnly: true });
      return {
        markers: readSchemaMarkers(database),
        schema: database
          .prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name")
          .all(),
        authority: hasRecipientAuthorityTable(database),
      };
    };
    const before = read();

    await expect(
      migrateAndOpenLegacyAgentDatabaseForTest({ agentId: "main", env }),
    ).rejects.toThrow(refusal);

    expect(read()).toEqual(before);
    expect(before).toMatchObject({ markers: { userVersion: version }, authority: false });
  });
});
