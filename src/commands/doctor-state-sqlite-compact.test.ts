import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  readPersistedQuarantineRow,
  seedOpenClawDatabaseQuarantine,
} from "../state/openclaw-quarantine-store.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import * as compactOwner from "./doctor-sqlite-compact.js";
import { runDoctorStateSqliteCompact } from "./doctor-state-sqlite-compact.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabase();
    vi.restoreAllMocks();
    cleanup();
  });
});

function createStateEnv(): NodeJS.ProcessEnv {
  const stateDir = tempDirs.make("openclaw-state-compact-");
  return { ...process.env, OPENCLAW_STATE_DIR: stateDir };
}

function withDatabase<T>(
  sqlitePath: string,
  readOnly: boolean,
  run: (database: DatabaseSync) => T,
) {
  const database = new (requireNodeSqlite().DatabaseSync)(sqlitePath, { readOnly });
  try {
    return run(database);
  } finally {
    database.close();
  }
}

function seedStateDatabase(env: NodeJS.ProcessEnv, withBloat = false): string {
  const sqlitePath = resolveOpenClawStateSqlitePath(env);
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  withDatabase(sqlitePath, false, (database) => {
    database.exec(`
      PRAGMA auto_vacuum = NONE;
      PRAGMA journal_mode = WAL;
      ${OPENCLAW_STATE_SCHEMA_SQL}
      CREATE TABLE compact_payload (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
    `);
    database
      .prepare(`INSERT INTO schema_meta
        (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
        VALUES ('primary', 'global', ?, NULL, NULL, 1, 1)`)
      .run(OPENCLAW_STATE_SCHEMA_VERSION);
    if (withBloat) {
      const insert = database.prepare("INSERT INTO compact_payload (payload) VALUES (?)");
      database.exec("BEGIN IMMEDIATE;");
      for (let index = 0; index < 512; index += 1) {
        insert.run(`${index}:${"x".repeat(8_192)}`);
      }
      database.exec("COMMIT; DELETE FROM compact_payload; PRAGMA wal_checkpoint(TRUNCATE);");
    }
  });
  if (process.platform !== "win32") {
    fs.chmodSync(sqlitePath, 0o666);
  }
  return sqlitePath;
}

function readPragma(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name};`).get() as Record<string, unknown>;
  return Number(row[name] ?? Object.values(row)[0]);
}

function createUnsafeIndexDrift(sqlitePath: string): void {
  withDatabase(sqlitePath, false, (database) => {
    database.exec(`
      CREATE TABLE unsafe_index_records (
        id INTEGER PRIMARY KEY,
        indexed_value TEXT NOT NULL,
        alternate_value TEXT NOT NULL
      );
      CREATE INDEX unsafe_index_records_value ON unsafe_index_records(indexed_value);
      INSERT INTO unsafe_index_records (indexed_value, alternate_value)
      VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_index_records_value ON unsafe_index_records(alternate_value)' WHERE name = 'unsafe_index_records_value'",
      )
      .run();
    database.exec("PRAGMA writable_schema = OFF;");
    database.exec(`PRAGMA schema_version = ${readPragma(database, "schema_version") + 1};`);
  });
}

function expectUnsafeIndex(database: DatabaseSync) {
  expect(database.prepare("PRAGMA integrity_check").all()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        integrity_check: expect.stringMatching(/missing from index unsafe_index_records_value/),
      }),
    ]),
  );
}

function expectOwnerOnlySqlitePermissions(sqlitePath: string): void {
  expect(fs.statSync(path.dirname(sqlitePath)).mode & 0o777).toBe(0o700);
  for (const candidate of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) {
    if (fs.existsSync(candidate)) {
      expect(fs.statSync(candidate).mode & 0o777).toBe(0o600);
    }
  }
}

describe("runDoctorStateSqliteCompact", () => {
  it("reports a missing canonical database as skipped", async () => {
    const env = createStateEnv();

    await expect(runDoctorStateSqliteCompact({ env })).resolves.toEqual({
      mode: "compact",
      path: resolveOpenClawStateSqlitePath(env),
      reason: "missing",
      skipped: true,
    });
  });

  it("clears authoritative quarantine after compaction", async () => {
    const env = createStateEnv();
    const sqlitePath = seedStateDatabase(env, true);
    seedOpenClawDatabaseQuarantine({
      env,
      kind: "state",
      path: sqlitePath,
      reason: "corrupt index",
    });

    await runDoctorStateSqliteCompact({ env });

    expect(readPersistedQuarantineRow(sqlitePath, { env })).toBeUndefined();
    expect(openOpenClawStateDatabase({ env }).db.isOpen).toBe(true);
  });

  it.skipIf(process.platform === "win32")("reapplies owner-only SQLite permissions", async () => {
    const env = createStateEnv();
    const sqlitePath = seedStateDatabase(env, true);

    await runDoctorStateSqliteCompact({ env });

    expectOwnerOnlySqlitePermissions(sqlitePath);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlink at the canonical database path",
    async () => {
      const env = createStateEnv();
      const canonicalPath = resolveOpenClawStateSqlitePath(env);
      const externalEnv = createStateEnv();
      const externalPath = seedStateDatabase(externalEnv);
      fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
      fs.symlinkSync(externalPath, canonicalPath);

      await expect(runDoctorStateSqliteCompact({ env })).rejects.toThrow(/not a regular file/);
    },
  );

  it("refuses compaction while this process owns an open shared-state handle", async () => {
    const env = createStateEnv();
    openOpenClawStateDatabase({ env });

    await expect(runDoctorStateSqliteCompact({ env })).rejects.toThrow(
      /already open in this process/,
    );
  });

  it("treats a busy truncating checkpoint as failure", async () => {
    const env = createStateEnv();
    const sqlitePath = seedStateDatabase(env);
    seedOpenClawDatabaseQuarantine({
      env,
      kind: "state",
      path: sqlitePath,
      reason: "busy checkpoint",
    });
    const sqlite = requireNodeSqlite();
    const reader = new sqlite.DatabaseSync(sqlitePath);
    const writer = new sqlite.DatabaseSync(sqlitePath);
    try {
      reader.exec("BEGIN; SELECT COUNT(*) FROM compact_payload;");
      writer.exec("INSERT INTO compact_payload (payload) VALUES ('newer wal frame');");

      // Exercise the real busy checkpoint result without waiting the production lock timeout.
      const compact = compactOwner.compactDoctorSqliteFile;
      vi.spyOn(compactOwner, "compactDoctorSqliteFile").mockImplementation((options) =>
        compact({ ...options, busyTimeoutMs: 0 }),
      );
      await expect(runDoctorStateSqliteCompact({ env })).rejects.toThrow(
        /checkpoint remained busy/,
      );
      expect(readPragma(writer, "auto_vacuum")).toBe(0);
      expect(readPersistedQuarantineRow(sqlitePath, { env })?.reason).toBe("busy checkpoint");
    } finally {
      reader.exec("ROLLBACK;");
      reader.close();
      writer.close();
    }
  });

  it("rejects stale secondary indexes before mutating the database", async () => {
    const env = createStateEnv();
    const sqlitePath = seedStateDatabase(env, true);
    createUnsafeIndexDrift(sqlitePath);
    withDatabase(sqlitePath, true, (before) => {
      expect(before.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expectUnsafeIndex(before);
    });

    await expect(runDoctorStateSqliteCompact({ env })).rejects.toThrow(
      /integrity_check failed.*missing from index unsafe_index_records_value/iu,
    );

    withDatabase(sqlitePath, true, (after) => {
      expect(readPragma(after, "auto_vacuum")).toBe(0);
      expect(readPragma(after, "freelist_count")).toBeGreaterThan(0);
      expectUnsafeIndex(after);
    });
  });
});
