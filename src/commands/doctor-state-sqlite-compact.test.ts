import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  type DoctorStateSqliteCompactReport,
  runDoctorStateSqliteCompact,
} from "./doctor-state-sqlite-compact.js";

const tempDirs: string[] = [];
type CompletedStateSqliteCompactReport = Extract<
  DoctorStateSqliteCompactReport,
  { skipped: false }
>;

function createStateEnv(): NodeJS.ProcessEnv {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-compact-"));
  tempDirs.push(stateDir);
  return { ...process.env, OPENCLAW_STATE_DIR: stateDir };
}

function seedStateDatabase(params: {
  env: NodeJS.ProcessEnv;
  role?: string;
  schemaVersion?: number;
  withBloat?: boolean;
}): string {
  const sqlitePath = resolveOpenClawStateSqlitePath(params.env);
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  const schemaVersion = params.schemaVersion ?? OPENCLAW_STATE_SCHEMA_VERSION;
  try {
    database.exec(`
      PRAGMA auto_vacuum = NONE;
      PRAGMA journal_mode = WAL;
      CREATE TABLE schema_meta (
        meta_key TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL
      );
      CREATE TABLE compact_payload (
        id INTEGER PRIMARY KEY,
        payload TEXT NOT NULL
      );
      PRAGMA user_version = ${schemaVersion};
    `);
    database
      .prepare("INSERT INTO schema_meta (meta_key, role, schema_version) VALUES (?, ?, ?)")
      .run("primary", params.role ?? "global", schemaVersion);
    if (params.withBloat) {
      const insert = database.prepare("INSERT INTO compact_payload (payload) VALUES (?)");
      database.exec("BEGIN IMMEDIATE;");
      for (let index = 0; index < 512; index += 1) {
        insert.run(`${index}:${"x".repeat(8_192)}`);
      }
      database.exec("COMMIT; DELETE FROM compact_payload; PRAGMA wal_checkpoint(TRUNCATE);");
    }
  } finally {
    database.close();
  }
  if (process.platform !== "win32") {
    fs.chmodSync(sqlitePath, 0o666);
  }
  return sqlitePath;
}

function readPragma(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name};`).get() as Record<string, unknown>;
  return Number(row[name] ?? Object.values(row)[0]);
}

function expectCompletedReport(
  report: DoctorStateSqliteCompactReport,
): asserts report is CompletedStateSqliteCompactReport {
  expect(report.skipped).toBe(false);
  if (report.skipped) {
    throw new Error("expected state SQLite compaction report");
  }
}

function expectOwnerOnlySqlitePermissions(sqlitePath: string): void {
  expect(fs.statSync(path.dirname(sqlitePath)).mode & 0o777).toBe(0o700);
  for (const candidate of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) {
    if (fs.existsSync(candidate)) {
      expect(fs.statSync(candidate).mode & 0o777).toBe(0o600);
    }
  }
}

afterEach(() => {
  closeOpenClawStateDatabase();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("runDoctorStateSqliteCompact", () => {
  it("reports a missing canonical database as skipped", () => {
    const env = createStateEnv();

    expect(runDoctorStateSqliteCompact({ env })).toEqual({
      mode: "compact",
      path: resolveOpenClawStateSqlitePath(env),
      reason: "missing",
      skipped: true,
    });
  });

  it("compacts the canonical database and reports verified before/after state", () => {
    const env = createStateEnv();
    const sqlitePath = seedStateDatabase({ env, withBloat: true });

    const report = runDoctorStateSqliteCompact({ env });

    expectCompletedReport(report);
    expect(report.path).toBe(sqlitePath);
    expect(report.before.autoVacuum).toBe(0);
    expect(report.after.autoVacuum).toBe(2);
    expect(report.before.freelistPages).toBeGreaterThan(0);
    expect(report.after.freelistPages).toBe(0);
    expect(report.after.dbSizeBytes).toBeLessThan(report.before.dbSizeBytes);
    expect(report.after.walSizeBytes).toBe(0);
    expect(report.after.pageSizeBytes).toBeGreaterThan(0);
    expect(report.reclaimedBytes).toBeGreaterThan(0);
    expect(report.quickCheck).toBe("ok");
    expect(report.integrityCheck).toBe("ok");
  });

  it.skipIf(process.platform === "win32")("reapplies owner-only SQLite permissions", () => {
    const env = createStateEnv();
    const sqlitePath = seedStateDatabase({ env, withBloat: true });

    runDoctorStateSqliteCompact({ env });

    expectOwnerOnlySqlitePermissions(sqlitePath);
  });

  it("rejects non-global schema metadata before mutation", () => {
    const env = createStateEnv();
    const sqlitePath = seedStateDatabase({ env, role: "agent", withBloat: true });

    expect(() => runDoctorStateSqliteCompact({ env })).toThrow(/schema role agent.*global/);

    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
    try {
      expect(readPragma(database, "auto_vacuum")).toBe(0);
      expect(readPragma(database, "freelist_count")).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });

  it.each([
    ["legacy", OPENCLAW_STATE_SCHEMA_VERSION - 1, /doctor --fix before compacting/],
    ["future", OPENCLAW_STATE_SCHEMA_VERSION + 1, /uses newer schema version/],
  ] as const)(
    "rejects a %s shared-state schema before mutation",
    (_label, schemaVersion, message) => {
      const env = createStateEnv();
      const sqlitePath = seedStateDatabase({ env, schemaVersion });

      expect(() => runDoctorStateSqliteCompact({ env })).toThrow(message);

      const sqlite = requireNodeSqlite();
      const database = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
      try {
        expect(readPragma(database, "auto_vacuum")).toBe(0);
      } finally {
        database.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a symlink at the canonical database path",
    () => {
      const env = createStateEnv();
      const canonicalPath = resolveOpenClawStateSqlitePath(env);
      const externalEnv = createStateEnv();
      const externalPath = seedStateDatabase({ env: externalEnv });
      fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
      fs.symlinkSync(externalPath, canonicalPath);

      expect(() => runDoctorStateSqliteCompact({ env })).toThrow(/not a regular file/);
    },
  );

  it("refuses compaction while this process owns an open shared-state handle", () => {
    const env = createStateEnv();
    openOpenClawStateDatabase({ env });

    expect(() => runDoctorStateSqliteCompact({ env })).toThrow(/already open in this process/);
  });

  it("treats a busy truncating checkpoint as failure", () => {
    const env = createStateEnv();
    const sqlitePath = seedStateDatabase({ env });
    const sqlite = requireNodeSqlite();
    const reader = new sqlite.DatabaseSync(sqlitePath);
    const writer = new sqlite.DatabaseSync(sqlitePath);
    try {
      reader.exec("BEGIN; SELECT COUNT(*) FROM compact_payload;");
      writer.exec("INSERT INTO compact_payload (payload) VALUES ('newer wal frame');");

      expect(() => runDoctorStateSqliteCompact({ env })).toThrow(/checkpoint remained busy/);
      expect(readPragma(writer, "auto_vacuum")).toBe(0);
    } finally {
      reader.exec("ROLLBACK;");
      reader.close();
      writer.close();
    }
  });
});
