import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { activateGatewayAgentDatabaseStartup } from "../gateway/server-agent-database-startup.js";
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
import {
  claimOpenClawAgentDatabaseLease,
  invalidateOpenClawAgentDatabaseIntegrityBeforeMutation,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";

const openRawDatabase = (pathname: string, options?: { readOnly?: boolean }) =>
  new DatabaseSync(pathname, options ?? {});
function databaseFixture(stateDir: string, baseEnv: NodeJS.ProcessEnv) {
  const env = { ...baseEnv, OPENCLAW_STATE_DIR: stateDir };
  return {
    env,
    agentPath: () => resolveOpenClawAgentSqlitePath({ agentId: "main", env }),
    ready: (config: import("../config/types.openclaw.js").OpenClawConfig) =>
      assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config }),
  };
}

// The startup FTS-attempt latch outlives each test and keys on dev:ino alone on Linux.
// Keep every agent file until the suite ends so a freed inode cannot alias a latched one.
const roots = useAutoCleanupTempDirTracker(afterAll);

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

async function createFixture(
  failure?: "mixed" | "backup" | "rebuild" | "writer" | "unowned" | "revoked",
) {
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
  invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(pathname);
  if (failure === "unowned") {
    using db = openRawDatabase(pathname);
    db.exec(
      "CREATE VIRTUAL TABLE unowned_fts USING fts5(text); INSERT INTO unowned_fts VALUES ('ab'||char(65534)||'cd')",
    );
  }
  if (failure === "unowned") {
    installSqliteFtsTokenizerMismatch(pathname, "unowned_fts");
  }
  if (failure === "mixed") {
    using db = openRawDatabase(pathname);
    db.exec(
      "CREATE TABLE probe(value TEXT); CREATE INDEX idx_probe ON probe(value); INSERT INTO probe VALUES ('abcdefgh')",
    );
  }
  if (failure === "mixed") {
    corruptSqliteIndexKey(pathname, "idx_probe", "abcdefgh", "abcdzzzz");
  }
  if (failure === "backup" || failure === "rebuild" || failure === "revoked") {
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
  if (failure === "revoked") {
    fs.writeFileSync(
      path.join(stateDir, "fail-repair.cjs"),
      [
        "const fs = require('node:fs'); const { DatabaseSync } = require('node:sqlite');",
        "const original = DatabaseSync.prototype.exec;",
        "DatabaseSync.prototype.exec = function(sql) { const result = original.call(this, sql);",
        "if (this.location() === " +
          JSON.stringify(pathname) +
          " && sql.includes(\"VALUES('rebuild')\")) {",
        "fs.writeFileSync(" + JSON.stringify(path.join(stateDir, "rebuild-entered")) + ", '1');",
        "while (!fs.existsSync(" +
          JSON.stringify(path.join(stateDir, "rebuild-release")) +
          ")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);",
        "} return result; };",
      ].join("\n"),
    );
  }
  let current = true;
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
          getConfig: () => config,
          getPluginRegistry: vi.fn(),
          getPluginMetadataSnapshot: () => undefined,
          isCurrent: () => current,
          log: { info: vi.fn(), warn: vi.fn() },
        });
        await admission.pendingPreparation;
      } finally {
        await owner.stop();
      }
    });
  return {
    ...fixture,
    config,
    session,
    entry,
    pathname,
    rows,
    logPath,
    start,
    foreignLease,
    stateDir,
    expire: () => {
      current = false;
    },
  };
}

it("admits a tokenizer-mismatched agent at Gateway startup with preserved content and backup", async () => {
  const fixture = await createFixture();
  const { session, entry, pathname, rows, logPath, env } = fixture;
  await fixture.start();
  expect(readAgentDatabaseAdmissionRefusal("main", { env })).toBeUndefined();
  expect(readStartupMigrationWarning()).toContain(
    "Rebuilt stale SQLite FTS indexes (agent main): session_transcript_fts",
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
  invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(pathname);
  await fixture.start();
  const refused = readAgentDatabaseAdmissionRefusal("main", { env });
  expect(refused?.code).toBe("agent-database-inspection-failed");
  expect(refused?.reason).toContain("Startup FTS repair failed");
  expect(refused?.repairHint).toContain("openclaw doctor --fix");
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

it.each(["mixed", "backup", "rebuild", "writer", "unowned"] as const)(
  "keeps %s failures quarantined with actionable Doctor guidance",
  async (failure) => {
    const fixture = await createFixture(failure);
    try {
      await fixture.start();
      const refusal = readAgentDatabaseAdmissionRefusal("main", { env: fixture.env });
      expect(refusal?.code).toBe("agent-database-inspection-failed");
      expect(refusal?.repairHint).toContain("openclaw doctor --fix");
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

it.each(["backup", "rebuild"] as const)(
  "latches failed %s before retry and allows replacement generation",
  async (failure) => {
    const fixture = await createFixture(failure);
    const backups = () =>
      fs
        .readdirSync(path.dirname(fixture.pathname))
        .filter(
          (name) =>
            name.startsWith("openclaw-index-recovery-") &&
            fs.existsSync(path.join(path.dirname(fixture.pathname), name, "database.sqlite")),
        );
    await fixture.start();
    expect(readAgentDatabaseAdmissionRefusal("main", { env: fixture.env })?.reason).toContain(
      "Startup FTS repair failed",
    );
    const firstBackups = backups();
    // Remove the injected error. The physical-generation latch, not the fault, must now refuse.
    fs.writeFileSync(path.join(fixture.stateDir, "fail-repair.cjs"), "");
    await closeOpenClawAgentDatabasesAsync();
    await closeStateDatabaseForTest();
    closeOpenClawAgentDatabasesForTest();
    await fixture.start();
    expect(readAgentDatabaseAdmissionRefusal("main", { env: fixture.env })?.reason).toContain(
      "Startup FTS repair failed",
    );
    // Native admission deliberately redacts host errors; exact latch rejection is covered
    // by the host authority unit test. No additional backup proves no second attempt.
    expect(backups()).toEqual(firstBackups);
    await closeOpenClawAgentDatabasesAsync();
    await closeStateDatabaseForTest();
    closeOpenClawAgentDatabasesForTest();
    const previous = fs.statSync(fixture.pathname).ino;
    fs.copyFileSync(fixture.pathname, fixture.pathname + ".replacement");
    fs.renameSync(fixture.pathname + ".replacement", fixture.pathname);
    expect(fs.statSync(fixture.pathname).ino).not.toBe(previous);
    invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(fixture.pathname);
    await fixture.start();
    expect(readAgentDatabaseAdmissionRefusal("main", { env: fixture.env })).toBeUndefined();
    expect(backups()).toHaveLength(firstBackups.length + 1);
    using db = openRawDatabase(fixture.pathname, { readOnly: true });
    expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(db.prepare("SELECT rowid, * FROM session_transcript_fts").all()).toEqual(fixture.rows);
  },
);

it("rolls back a rebuilt index when the live startup grant expires before commit", async () => {
  const fixture = await createFixture("revoked");
  const started = fixture.start();
  try {
    await vi.waitFor(
      () => expect(fs.existsSync(path.join(fixture.stateDir, "rebuild-entered"))).toBe(true),
      { timeout: 30000 },
    );
    fixture.expire();
  } finally {
    fs.writeFileSync(path.join(fixture.stateDir, "rebuild-release"), "1");
  }
  await started;
  using db = openRawDatabase(fixture.pathname, { readOnly: true });
  expect(db.prepare("PRAGMA integrity_check").all()).toContainEqual({
    integrity_check: "malformed inverted index for FTS5 table main.session_transcript_fts",
  });
  expect(db.prepare("SELECT rowid, * FROM session_transcript_fts").all()).toEqual(fixture.rows);
  expect(
    fs
      .readdirSync(path.dirname(fixture.pathname))
      .filter((name) => name.startsWith("openclaw-index-recovery-")),
  ).toHaveLength(1);
  await flushLogger();
  expect(fs.readFileSync(fixture.logPath, "utf8")).not.toContain(
    "Rebuilt stale SQLite FTS indexes",
  );
});
