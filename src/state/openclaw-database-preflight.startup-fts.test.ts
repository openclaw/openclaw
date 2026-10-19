import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { activateGatewayAgentDatabaseStartup } from "../gateway/server-agent-database-startup.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import {
  corruptSqliteIndexKey,
  installSqliteFtsTokenizerMismatch,
} from "../infra/sqlite-index-corruption.test-support.js";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";
import { readStartupMigrationWarning } from "../infra/state-migrations.messages.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { readAgentDatabaseAdmissionRefusal } from "./agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import { databaseFixture, openRawDatabase } from "./database-preflight-fixtures.test-support.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "./openclaw-agent-db.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  await flushLogger();
  clearRuntimeConfigSnapshot();
  setLoggerOverride(null);
  resetLogger();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function createFixture(failure?: "mixed" | "backup" | "rebuild" | "writer") {
  const stateDir = fs.realpathSync.native(roots.make("startup-fts-"));
  const fixture = databaseFixture(stateDir, process.env);
  const { env } = fixture;
  const config = {
    session: { maintenance: { mode: "warn" as const } },
    agents: { ownership: "explicit" as const, entries: { main: {} } },
  };
  const logPath = path.join(stateDir, "startup.log");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
  setRuntimeConfigSnapshot(config);
  setLoggerOverride({ level: "warn", file: logPath, consoleLevel: "silent" });
  const session = { agentId: "main", env, sessionKey: "agent:main:retained" };
  const entry = await replaceSessionEntry(session, { sessionId: "retained", updatedAt: 1 });
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  const pathname = fixture.agentPath();
  let rows: unknown;
  {
    using db = openRawDatabase(pathname);
    db.exec("INSERT INTO session_transcript_fts(text) VALUES ('ab'||char(65534)||'cd')");
    rows = db.prepare("SELECT rowid, * FROM session_transcript_fts").all();
  }
  installSqliteFtsTokenizerMismatch(pathname, "session_transcript_fts");
  retireSqliteDatabaseAdmissionForPath(pathname);
  if (failure === "mixed") {
    using db = openRawDatabase(pathname);
    db.exec(
      "CREATE TABLE probe(value TEXT); CREATE INDEX idx_probe ON probe(value); INSERT INTO probe VALUES ('abcdefgh')",
    );
  }
  if (failure === "mixed") {
    corruptSqliteIndexKey(pathname, "idx_probe", "abcdefgh", "abcdzzzz");
  }
  if (failure === "backup" || failure === "rebuild") {
    const preload = path.join(stateDir, "fail-repair.cjs");
    fs.writeFileSync(
      preload,
      failure === "backup"
        ? `
      const fs = require('node:fs');
      const copy = fs.copyFileSync;
      fs.copyFileSync = function(src, dst, ...args) {
        if (String(dst).includes('openclaw-index-recovery-')) throw new Error('synthetic backup failure');
        return copy.call(this, src, dst, ...args);
      };`
        : `
      const { DatabaseSync } = require('node:sqlite');
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) {
        if (this.location() === ${JSON.stringify(pathname)} && sql.includes("VALUES('rebuild')")) throw new Error('synthetic rebuild failure');
        return exec.call(this, sql);
      };`,
    );
    for (const [key, value] of Object.entries(sqliteWorkerPreloadEnv(preload))) {
      vi.stubEnv(key, value);
    }
  }
  const foreignLease =
    failure === "writer"
      ? claimOpenClawAgentDatabaseLease({ agentId: "main", path: pathname, env })
      : undefined;
  const start = () =>
    withAgentDatabaseStartupAdmission(async (admission) => {
      await fixture.ready(config);
      const owner = admission.adopt();
      try {
        const activate = admission.activate.bind(admission);
        vi.spyOn(admission, "activate").mockImplementation((activation) =>
          activate({ ...activation, publishAgent: async () => {} }),
        );
        activateGatewayAgentDatabaseStartup({
          admission,
          preparationReady: Promise.resolve(),
          waitForPostReadyWork: async () => {},
          getConfig: () => config,
          getPluginRegistry: vi.fn(),
          getPluginMetadataSnapshot: () => undefined,
          isCurrent: () => true,
          log: { info: vi.fn(), warn: vi.fn() },
        });
        await admission.pendingPreparation;
      } finally {
        await owner.stop();
      }
    });
  return { ...fixture, config, session, entry, pathname, rows, logPath, start, foreignLease };
}

it("admits a tokenizer-mismatched agent at Gateway startup with preserved content and backup", async () => {
  const fixture = await createFixture();
  const { session, entry, pathname, rows, logPath, env } = fixture;
  await fixture.start();
  expect(readAgentDatabaseAdmissionRefusal("main", { env })).toBeUndefined();
  expect(readStartupMigrationWarning()).toContain(
    "Rebuilt stale SQLite FTS indexes (agent main): session_transcript_fts=1",
  );
  expect(loadSessionEntry(session)).toEqual(entry);
  {
    using db = openRawDatabase(pathname, { readOnly: true });
    expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(db.prepare("SELECT rowid, * FROM session_transcript_fts").all()).toEqual(rows);
    const backupDir = fs
      .readdirSync(path.dirname(pathname))
      .find((name) => name.startsWith("openclaw-index-recovery-"));
    expect(backupDir).toBeDefined();
    using backup = openRawDatabase(
      path.join(path.dirname(pathname), backupDir!, "database.sqlite"),
      {
        readOnly: true,
      },
    );
    expect(backup.prepare("SELECT rowid, * FROM session_transcript_fts").all()).toEqual(rows);
    expect(backup.prepare("PRAGMA integrity_check").all()).toEqual([
      { integrity_check: "malformed inverted index for FTS5 table main.session_transcript_fts" },
    ]);
  }
  await closeOpenClawAgentDatabasesAsync();
  await flushLogger();
  const log = fs.readFileSync(logPath, "utf8");
  expect(
    log.split("\n").filter((line) => line.includes("Rebuilt stale SQLite FTS indexes")),
  ).toHaveLength(1);
  await closeStateDatabaseForTest();
  closeOpenClawAgentDatabasesForTest();
  installSqliteFtsTokenizerMismatch(pathname, "session_transcript_fts");
  retireSqliteDatabaseAdmissionForPath(pathname);
  await fixture.start();
  const refused = readAgentDatabaseAdmissionRefusal("main", { env });
  expect(refused?.code).toBe("agent-database-inspection-failed");
  expect(refused?.reason).toContain("Startup FTS repair failed");
  expect(refused?.repairHint).toContain(
    "openclaw doctor --session-sqlite recover --session-sqlite-agent main",
  );
  {
    using db = openRawDatabase(pathname, { readOnly: true });
    expect(db.prepare("SELECT rowid, * FROM session_transcript_fts").all()).toEqual(rows);
    expect(db.prepare("PRAGMA integrity_check").all()).toEqual([
      { integrity_check: "malformed inverted index for FTS5 table main.session_transcript_fts" },
    ]);
  }
  expect(
    fs
      .readdirSync(path.dirname(pathname))
      .filter((name) => name.startsWith("openclaw-index-recovery-")),
  ).toHaveLength(1);
});

it.each(["mixed", "backup", "rebuild", "writer"] as const)(
  "keeps %s failures quarantined with actionable Doctor guidance",
  async (failure) => {
    const fixture = await createFixture(failure);
    try {
      await fixture.start();
      const refusal = readAgentDatabaseAdmissionRefusal("main", { env: fixture.env });
      expect(refusal?.code).toBe("agent-database-inspection-failed");
      expect(refusal?.repairHint).toContain(
        "openclaw doctor --session-sqlite recover --session-sqlite-agent main",
      );
      expect(() => loadSessionEntry(fixture.session)).toThrow(/integrity_check|quarantined/);
      using db = openRawDatabase(fixture.pathname, { readOnly: true });
      expect(db.prepare("SELECT rowid, * FROM session_transcript_fts").all()).toEqual(fixture.rows);
      expect(db.prepare("PRAGMA integrity_check").all()).toContainEqual({
        integrity_check: "malformed inverted index for FTS5 table main.session_transcript_fts",
      });
      const backups = fs
        .readdirSync(path.dirname(fixture.pathname))
        .filter(
          (name) =>
            name.startsWith("openclaw-index-recovery-") &&
            fs.existsSync(path.join(path.dirname(fixture.pathname), name, "database.sqlite")),
        );
      expect(backups).toHaveLength(failure === "rebuild" ? 1 : 0);
    } finally {
      if (fixture.foreignLease) {
        releaseOpenClawAgentDatabaseLease(fixture.foreignLease, { env: fixture.env });
      }
    }
  },
);
