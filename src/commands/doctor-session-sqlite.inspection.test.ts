import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import {
  readOnlySqliteValidationSnapshot,
  resolveTargetSqlitePath,
} from "../infra/session-sqlite-migration-readers.js";
import { readAgentDatabaseDeletionSnapshot } from "../state/agent-deletion-journal.read.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  readMigrationManifest,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { autoCleanupTempDirs, createLegacyStore } = useDoctorSessionSqliteTestFixture();

function createValidationDatabase(label: string, populate: (database: DatabaseSync) => void) {
  const stateDir = autoCleanupTempDirs.make(`openclaw-doctor-${label}-`);
  const target = {
    agentId: "main",
    storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
  };
  const sqlitePath = resolveTargetSqlitePath(target);
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const database = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(sqlitePath);
  try {
    populate(database);
  } finally {
    database.close();
  }
  return target;
}

describe("runDoctorSessionSqlite", () => {
  it.each([13, 14, 17])("reads v%i validation identities without parsing entry JSON", (version) => {
    const promoted = version === 17;
    const sessionKey = `agent:main:v${version}-reader`;
    const sessionId = promoted ? "promoted-session-id" : `v${version}-reader-session`;
    const table = version === 13 ? "session_entries" : "session_nodes";
    const idColumn = version === 13 ? "session_id" : "current_session_id";
    const entryJson = JSON.stringify({
      ...(promoted ? { payload: "x".repeat(2 * 1024 * 1024) } : {}),
      sessionId: promoted ? "embedded-stale-id" : sessionId,
      updatedAt: version,
    });
    const target = createValidationDatabase(`v${version}-reader`, (database) => {
      database.exec(`
        CREATE TABLE ${table} (
          session_key TEXT NOT NULL PRIMARY KEY,
          ${idColumn} TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          ${promoted ? "entry_valid INTEGER NOT NULL," : ""}
          updated_at INTEGER NOT NULL
        );
        PRAGMA user_version = ${version};
      `);
      database
        .prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ${promoted ? "1," : ""} ?)`)
        .run(sessionKey, sessionId, entryJson, version);
      if (version === 14) {
        database.exec(
          "INSERT INTO session_nodes VALUES ('agent:main:transcript-only', 'transcript-only-session', '{}', 14)",
        );
      }
      if (promoted) {
        database.exec(
          "CREATE TABLE transcript_events (session_id TEXT NOT NULL, event_json TEXT NOT NULL)",
        );
        database
          .prepare("INSERT INTO transcript_events VALUES (?, '{}'), (?, '{}')")
          .run(sessionId, sessionId);
      }
    });
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      expect(readOnlySqliteValidationSnapshot(target)).toEqual({
        ok: true,
        snapshot: {
          sessionIdsBySessionKey: new Map([[sessionKey, sessionId]]),
          sessionKeysBySessionId: new Map(),
          transcriptEventCountsBySessionId: new Map(promoted ? [[sessionId, 2]] : []),
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

  it.each([
    "dry-run",
    "inspect",
    "explicit-agent",
    "sqlite-only",
    "stat-failure",
    "directory",
  ] as const)("inspects %s stores without mutating them", async (kind) => {
    const legacy =
      kind !== "explicit-agent" && kind !== "sqlite-only" ? createLegacyStore() : undefined;
    const stateDir = legacy?.stateDir ?? autoCleanupTempDirs.make("openclaw-doctor-inspection-");
    const storePath =
      legacy?.storePath ??
      path.join(
        stateDir,
        kind === "explicit-agent" ? "shared" : "agents/main/sessions",
        "sessions.json",
      );
    const env = legacy?.env ?? { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    if (kind === "stat-failure") {
      // ENOTDIR exercises the non-ENOENT stat failure.
      fs.rmSync(path.dirname(storePath), { force: true, recursive: true });
      fs.writeFileSync(path.dirname(storePath), "not a directory\n", { mode: 0o600 });
    }
    if (kind === "sqlite-only") {
      await upsertSessionEntryCore(
        { agentId: "main", env, sessionKey: "agent:main:main", storePath },
        { sessionId: "sqlite-session", updatedAt: 1 },
      );
    }
    const report = await runDoctorSessionSqlite({
      env,
      mode: kind === "dry-run" ? "dry-run" : "inspect",
      ...(kind === "sqlite-only"
        ? { allAgents: true, cfg: {} }
        : { store: kind === "directory" ? path.dirname(storePath) : storePath }),
      ...(kind === "explicit-agent" ? { agent: "ops" } : {}),
    });
    if (kind === "stat-failure" || kind === "directory") {
      expect(report.targets[0]?.issues).toEqual([
        expect.objectContaining({
          code: "store_unreadable",
          ...(kind === "directory"
            ? { message: expect.stringContaining("not a regular file") }
            : {}),
        }),
      ]);
      return;
    }
    if (kind === "explicit-agent") {
      expect(report.targets).toHaveLength(1);
      expect(report.targets[0]).toMatchObject({ agentId: "ops", storePath });
      return;
    }
    expect(report.totals).toMatchObject({
      issues: 0,
      legacyEntries: kind === "sqlite-only" ? 0 : 1,
      sqliteEntries: kind === "sqlite-only" ? 1 : 0,
      targets: 1,
      ...(kind === "dry-run"
        ? {
            importedEntries: 0,
            importedTranscriptEvents: 0,
            unreferencedJsonlFiles: 2,
            validatedEntries: 1,
            validatedTranscriptEvents: 2,
          }
        : {}),
    });
    if (kind === "sqlite-only") {
      expect(fs.existsSync(storePath)).toBe(false);
    } else {
      expect(report.targets[0]?.sqlitePath).toBeTruthy();
      expect(fs.existsSync(report.targets[0]?.sqlitePath ?? "")).toBe(false);
    }
  });

  it("migrates a dormant historical agent database before all-agent import compaction", async () => {
    const tempDir = autoCleanupTempDirs.make("openclaw-doctor-session-sqlite-");
    const stateDir = path.join(tempDir, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    // This migration fixture has known-empty deletion history, not orphaned retained SQLite.
    openOpenClawStateDatabase({ env });
    expect(readAgentDatabaseDeletionSnapshot(env)?.retainedDeletions).toEqual({ status: "empty" });
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

// Use the shipped July schema so Doctor owns the upgrade. Empty session tables
// preserve the dormant-agent case: import has no rows to open before compaction.
function createHistoricalV1AgentDatabase(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
}): string {
  const sqlitePath = resolveOpenClawAgentSqlitePath(params);
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const sqlite = nodeSqlite.requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec(
      fs.readFileSync(
        new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v1.sql", import.meta.url),
        "utf8",
      ),
    );
    database.exec("PRAGMA user_version = 1;");
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
