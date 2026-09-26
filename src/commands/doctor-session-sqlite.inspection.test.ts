import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import {
  readOnlySqliteValidationSnapshot,
  resolveTargetSqlitePath,
} from "../infra/session-sqlite-migration-readers.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  readMigrationManifest,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { autoCleanupTempDirs, createLegacyStore } = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it("uses the requested agent as the owner for explicit-store maintenance", async () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-explicit-ops-");
    const storePath = path.join(stateDir, "shared", "sessions.json");
    const report = await runDoctorSessionSqlite({
      agent: "ops",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      mode: "inspect",
      store: storePath,
    });

    expect(report.targets).toHaveLength(1);
    expect(report.targets[0]).toMatchObject({ agentId: "ops", storePath });
  });

  it("reads populated v13 session_entries before migration", () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-v13-reader-");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const target = { agentId: "main", storePath };
    const sqlitePath = resolveTargetSqlitePath(target);
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const sqlite = nodeSqlite.requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath);
    try {
      database.exec(`
        CREATE TABLE session_entries (
          session_key TEXT NOT NULL PRIMARY KEY,
          session_id TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO session_entries (session_key, session_id, entry_json, updated_at)
        VALUES (
          'agent:main:v13-reader',
          'v13-reader-session',
          '{"sessionId":"v13-reader-session","updatedAt":13}',
          13
        );
        PRAGMA user_version = 13;
      `);
    } finally {
      database.close();
    }

    expect(readOnlySqliteValidationSnapshot(target)).toEqual({
      ok: true,
      snapshot: {
        sessionIdsBySessionKey: new Map([["agent:main:v13-reader", "v13-reader-session"]]),
        sessionKeysBySessionId: new Map(),
        transcriptEventCountsBySessionId: new Map(),
      },
    });
  });

  it("excludes v14 transcript-only nodes from doctor entry reads", () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-v14-reader-");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const target = { agentId: "main", storePath };
    const sqlitePath = resolveTargetSqlitePath(target);
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const sqlite = nodeSqlite.requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath);
    try {
      database.exec(`
        CREATE TABLE session_nodes (
          session_key TEXT NOT NULL PRIMARY KEY,
          current_session_id TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO session_nodes VALUES
          ('agent:main:transcript-only', 'transcript-only-session', '{}', 14),
          ('agent:main:v14-reader', 'v14-reader-session',
           '{"sessionId":"v14-reader-session","updatedAt":14}', 14);
        PRAGMA user_version = 14;
      `);
    } finally {
      database.close();
    }

    expect(readOnlySqliteValidationSnapshot(target)).toEqual({
      ok: true,
      snapshot: {
        sessionIdsBySessionKey: new Map([["agent:main:v14-reader", "v14-reader-session"]]),
        sessionKeysBySessionId: new Map(),
        transcriptEventCountsBySessionId: new Map(),
      },
    });
  });

  it("reads compact promoted validation identities without parsing large entry JSON", () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-compact-validation-");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const target = { agentId: "main", storePath };
    const sqlitePath = resolveTargetSqlitePath(target);
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const sqlite = nodeSqlite.requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath);
    const payload = "x".repeat(2 * 1024 * 1024);
    const entryJson = JSON.stringify({
      payload,
      sessionId: "embedded-stale-id",
      updatedAt: 17,
    });
    try {
      database.exec(`
        CREATE TABLE session_nodes (
          session_key TEXT NOT NULL PRIMARY KEY,
          current_session_id TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          entry_valid INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE transcript_events (
          session_id TEXT NOT NULL,
          event_json TEXT NOT NULL
        );
      `);
      database
        .prepare("INSERT INTO session_nodes VALUES (?, ?, ?, 1, 17)")
        .run("agent:main:compact", "promoted-session-id", entryJson);
      database
        .prepare("INSERT INTO transcript_events VALUES (?, '{}'), (?, '{}')")
        .run("promoted-session-id", "promoted-session-id");
    } finally {
      database.close();
    }
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      expect(readOnlySqliteValidationSnapshot(target)).toEqual({
        ok: true,
        snapshot: {
          sessionIdsBySessionKey: new Map([["agent:main:compact", "promoted-session-id"]]),
          sessionKeysBySessionId: new Map(),
          transcriptEventCountsBySessionId: new Map([["promoted-session-id", 2]]),
        },
      });
      expect(parseSpy.mock.calls.some(([value]) => value === entryJson)).toBe(false);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("imports zero legacy records without parsing canonical entry JSON", async () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-empty-import-");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, "{}\n", { mode: 0o600 });
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const entryJson = JSON.stringify({
      payload: "empty-import-sentinel".repeat(64 * 1024),
      sessionId: "canonical-only-session",
      updatedAt: 19,
    });
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("agent:main:main", "canonical-only-session", entryJson, 19);
    database.db.prepare("UPDATE session_nodes SET entry_valid = 1").run();
    const sqlitePath = database.path;
    closeOpenClawAgentDatabasesForTest();
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      const report = await runDoctorSessionSqlite({ env, mode: "import", store: storePath });
      expect(report.totals).toMatchObject({
        importedEntries: 0,
        issues: 0,
        legacyEntries: 0,
        sqliteEntries: 1,
      });
      expect(parseSpy.mock.calls.some(([value]) => value === entryJson)).toBe(false);
    } finally {
      parseSpy.mockRestore();
    }
    const verifier = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(sqlitePath, {
      readOnly: true,
    });
    try {
      expect(verifier.prepare("SELECT entry_json FROM session_nodes").get()).toEqual({
        entry_json: entryJson,
      });
    } finally {
      verifier.close();
    }
  });

  it("dry-runs a legacy store without writing SQLite rows", async () => {
    const store = createLegacyStore();

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "dry-run",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: 0,
      legacyEntries: 1,
      sqliteEntries: 0,
      targets: 1,
      unreferencedJsonlFiles: 2,
      validatedEntries: 1,
      validatedTranscriptEvents: 2,
    });
    expect(report.targets[0]?.sqlitePath).toBeTruthy();
    expect(fs.existsSync(report.targets[0]?.sqlitePath ?? "")).toBe(false);
  });

  it("inspects a legacy store without creating a SQLite database", async () => {
    const store = createLegacyStore();

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      issues: 0,
      legacyEntries: 1,
      sqliteEntries: 0,
      targets: 1,
    });
    expect(report.targets[0]?.sqlitePath).toBeTruthy();
    expect(fs.existsSync(report.targets[0]?.sqlitePath ?? "")).toBe(false);
  });

  it("reports store_unreadable instead of crashing when the store stat fails", async () => {
    const store = createLegacyStore();
    // Replace the sessions directory with a regular file so statSync on the
    // store path throws ENOTDIR (non-ENOENT errors bypass throwIfNoEntry).
    fs.rmSync(store.sessionDir, { force: true, recursive: true });
    fs.writeFileSync(store.sessionDir, "not a directory\n", { mode: 0o600 });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.targets[0]?.issues).toEqual([
      expect.objectContaining({ code: "store_unreadable" }),
    ]);
  });

  it("reports store_unreadable for a non-regular store path", async () => {
    const store = createLegacyStore();

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.sessionDir,
    });

    expect(report.targets[0]?.issues).toEqual([
      expect.objectContaining({
        code: "store_unreadable",
        message: expect.stringContaining("not a regular file"),
      }),
    ]);
  });

  it("inspects SQLite-only all-agent targets without requiring a legacy store", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-session-sqlite-"));
    try {
      const stateDir = path.join(tempDir, "state");
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      await upsertSessionEntryCore(
        { agentId: "main", env, sessionKey: "agent:main:main", storePath },
        { sessionId: "sqlite-session", updatedAt: Date.now() },
      );

      const report = await runDoctorSessionSqlite({
        allAgents: true,
        cfg: {},
        env,
        mode: "inspect",
      });

      expect(fs.existsSync(storePath)).toBe(false);
      expect(report.totals).toMatchObject({
        issues: 0,
        legacyEntries: 0,
        sqliteEntries: 1,
        targets: 1,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("migrates a dormant historical agent database before all-agent import compaction", async () => {
    const tempDir = autoCleanupTempDirs.make("openclaw-doctor-session-sqlite-");
    const stateDir = path.join(tempDir, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const agentIds = ["dormant", "current"] as const;
    for (const agentId of agentIds) {
      const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}\n", { mode: 0o600 });
    }
    const dormantPath = createHistoricalV1AgentDatabase({ agentId: "dormant", env });
    const currentPath = openOpenClawAgentDatabase({ agentId: "current", env }).path;
    closeOpenClawAgentDatabasesForTest();

    const sqlite = nodeSqlite.requireNodeSqlite();
    const currentBefore = new sqlite.DatabaseSync(currentPath);
    const currentUpdatedAt = expectDefined(
      currentBefore
        .prepare("SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'")
        .get() as { updated_at?: number } | undefined,
      "current schema metadata",
    ).updated_at;
    currentBefore.close();

    const report = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: { agents: { list: agentIds.map((id) => ({ id })) } },
      env,
      mode: "import",
    });

    expect(report.totals).toMatchObject({
      importedEntries: 0,
      issues: 0,
      targets: 2,
    });
    expect(report.targets.find((target) => target.agentId === "dormant")?.compact).toMatchObject({
      skipped: false,
    });
    const dormantAfter = new sqlite.DatabaseSync(dormantPath);
    const currentAfter = new sqlite.DatabaseSync(currentPath);
    try {
      expect(dormantAfter.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        dormantAfter
          .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });
      expect(
        dormantAfter
          .prepare("PRAGMA table_info(session_windows)")
          .all()
          .map((column) => (column as { name?: unknown }).name),
      ).toContain("session_scope");
      expect(
        dormantAfter
          .prepare("PRAGMA table_info(memory_index_sources)")
          .all()
          .map((column) => (column as { name?: unknown }).name),
      ).toEqual(["id", "path", "source", "hash", "mtime", "size"]);
      expect(dormantAfter.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(dormantAfter.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        currentAfter
          .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({
        schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
        updated_at: currentUpdatedAt,
      });
    } finally {
      dormantAfter.close();
      currentAfter.close();
    }
  });

  it("keeps mismatched older agent schema versions blocking during all-agent import", async () => {
    const tempDir = autoCleanupTempDirs.make("openclaw-doctor-session-sqlite-");
    const stateDir = path.join(tempDir, "token=supersecret", "state");
    const sessionsDir = path.join(stateDir, "agents", "drifted", "sessions");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}\n", { mode: 0o600 });
    const sqlitePath = openOpenClawAgentDatabase({ agentId: "drifted", env }).path;
    closeOpenClawAgentDatabasesForTest();

    const sqlite = nodeSqlite.requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath);
    try {
      database.exec("PRAGMA user_version = 1;");
      database
        .prepare("UPDATE schema_meta SET schema_version = 2 WHERE meta_key = 'primary'")
        .run();
    } finally {
      database.close();
    }

    const report = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: { agents: { list: [{ id: "drifted" }] } },
      env,
      mode: "import",
    });

    expect(report.targets[0]?.issues).toEqual([
      expect.objectContaining({
        code: "sqlite_compact_failed",
        message: expect.stringMatching(/uses schema version 1/iu),
      }),
    ]);
    const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
    expect(manifest.failedAt).toBeTruthy();
    expect(manifest.failureReports).toBeDefined();
    const failureReportPath = expectDefined(
      report.migrationRun?.failureReportMarkdownPath,
      "blocking migration failure report path",
    );
    const failureReport = fs.readFileSync(failureReportPath, "utf-8");
    expect(failureReport).toContain("sqlite_compact_failed");
    expect(failureReport).toContain("openclaw doctor --session-sqlite recover --github-issue");
    expect(failureReport).not.toContain("supersecret");
    const after = new sqlite.DatabaseSync(sqlitePath);
    try {
      expect(after.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(
        after.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ schema_version: 2 });
    } finally {
      after.close();
    }
  });
});

// Build the physical v1 layout directly so the doctor path, not the runtime
// opener, owns the upgrade. Empty session tables preserve the dormant-agent
// reproduction: import has no rows to open before its compact step.
function createHistoricalV1AgentDatabase(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
}): string {
  const sqlitePath = resolveOpenClawAgentSqlitePath(params);
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const sqlite = nodeSqlite.requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec(`
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        session_id TEXT NOT NULL PRIMARY KEY,
        session_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_entries (
        session_key TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      CREATE TABLE memory_index_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL
      );
      INSERT INTO memory_index_state (id, revision) VALUES (1, 1);
      CREATE TABLE memory_index_sources (
        source_kind TEXT NOT NULL DEFAULT 'memory',
        source_key TEXT NOT NULL,
        path TEXT,
        session_id TEXT,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (source_kind, source_key),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      CREATE TABLE memory_index_chunks (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL DEFAULT 'memory',
        source_key TEXT NOT NULL,
        path TEXT NOT NULL,
        session_id TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        embedding_dims INTEGER,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (source_kind, source_key)
          REFERENCES memory_index_sources(source_kind, source_key) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      PRAGMA user_version = 1;
    `);
    database
      .prepare(
        `
          INSERT INTO schema_meta
            (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
          VALUES ('primary', 'agent', 1, ?, NULL, 1, 1)
        `,
      )
      .run(params.agentId);
  } finally {
    database.close();
  }
  return sqlitePath;
}
