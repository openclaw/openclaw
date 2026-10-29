import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import {
  readActiveOpenClawAgentDatabaseLeasesReadOnly,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

function openRawDatabase(pathname: string, options: { readOnly?: boolean } = {}) {
  return new DatabaseSync(pathname, options);
}

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
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  };
  const fixture = {
    env,
    agentPath: () => resolveOpenClawAgentSqlitePath({ agentId: "main", env }),
    ready: (config: OpenClawConfig) =>
      assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config }),
  };
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

/** Pause after the backup copy, inside the genuine native repair and shared write fence. */
function pauseNativeRepair(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const directory = path.dirname(fixture.pathname);
  const entered = path.join(directory, "native-repair-entered.json");
  const release = path.join(directory, "native-repair-release");
  const preload = path.join(directory, "native-repair-pause.cjs");
  fs.writeFileSync(
    preload,
    [
      "const fs = require('node:fs');",
      "const { threadId } = require('node:worker_threads');",
      "const copy = fs.copyFileSync;",
      "fs.copyFileSync = function(src, dst, ...args) {",
      "const result = copy.call(this, src, dst, ...args);",
      "if (String(dst).includes('openclaw-index-recovery-')) {",
      "fs.writeFileSync(" + JSON.stringify(entered) + ", JSON.stringify({ threadId, dst }));",
      "const deadline = Date.now() + 45000;",
      "while (!fs.existsSync(" + JSON.stringify(release) + ")) {",
      "if (Date.now() > deadline) throw new Error('native repair pause was not released');",
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);",
      "} } return result; };",
    ].join("\n"),
  );
  for (const [key, value] of Object.entries(sqliteWorkerPreloadEnv(preload))) {
    vi.stubEnv(key, value);
  }
  return {
    async entered() {
      await vi.waitFor(() => expect(fs.existsSync(entered)).toBe(true), { timeout: 15000 });
      const evidence = JSON.parse(fs.readFileSync(entered, "utf8")) as {
        threadId: number;
        dst: string;
      };
      expect(process.versions.bun).toBeUndefined();
      expect(evidence.threadId).toBeGreaterThan(0);
      expect(fs.existsSync(evidence.dst)).toBe(true);
      const owners = readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.env });
      expect(owners.filter((owner) => owner.path === fixture.pathname)).toHaveLength(1);
      console.info("NATIVE FTS repair window", {
        threadId: evidence.threadId,
        liveLeaseCount: owners.length,
      });
      return evidence;
    },
    release() {
      fs.writeFileSync(release, "release");
    },
  };
}

it("NATIVE refuses source replacement after repair admission without mutating or publishing the replacement", async () => {
  const fixture = await createFixture();
  const replacement = fixture.pathname + ".replacement";
  {
    using db = openRawDatabase(replacement);
    db.exec(
      "CREATE TABLE replacement_sentinel(value TEXT); INSERT INTO replacement_sentinel VALUES ('untouched')",
    );
  }
  const expectedBytes = fs.readFileSync(replacement);
  const pause = pauseNativeRepair(fixture);
  const starting = fixture.start();
  try {
    await pause.entered();
    // Move the open image and its sidecars before installing a distinct physical file.
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = fixture.pathname + suffix;
      if (fs.existsSync(source)) {
        fs.renameSync(source, fixture.pathname + ".original" + suffix);
      }
    }
    fs.renameSync(replacement, fixture.pathname);
  } finally {
    pause.release();
    await starting;
  }
  expect(fs.readFileSync(fixture.pathname)).toEqual(expectedBytes);
  using replacementDb = openRawDatabase(fixture.pathname, { readOnly: true });
  expect(replacementDb.prepare("SELECT value FROM replacement_sentinel").all()).toEqual([
    { value: "untouched" },
  ]);
  expect(replacementDb.prepare("PRAGMA integrity_check").all()).toEqual([
    { integrity_check: "ok" },
  ]);
  const refusal = readAgentDatabaseAdmissionRefusal("main", { env: fixture.env });
  expect(refusal?.code).toBe("agent-database-inspection-failed");
  expect(refusal?.reason).toContain("integrity_check");
  expect(refusal?.reason).toContain("Startup FTS repair failed");
  expect(refusal?.reason).toContain("SQLite transaction admission was refused");
  expect(readStartupMigrationWarning() ?? "").not.toContain("Rebuilt stale SQLite FTS indexes");
  await flushLogger();
  expect(fs.readFileSync(fixture.logPath, "utf8")).not.toContain(
    "Rebuilt stale SQLite FTS indexes",
  );
});

it("NATIVE hardlink aliases cannot acquire write or maintenance authority during repair; controls remain usable", async () => {
  const fixture = await createFixture();
  const alias = fixture.pathname + ".alias";
  fs.linkSync(fixture.pathname, alias);
  expect(fs.statSync(alias).ino).toBe(fs.statSync(fixture.pathname).ino);
  // A distinct native process cannot borrow this process's actor or open transaction.
  const before = await runNativeLeaseCompetitor(fixture, alias, "write");
  expect(before).toEqual({ acquired: true });
  const pause = pauseNativeRepair(fixture);
  const starting = fixture.start();
  try {
    await pause.entered();
    for (const mode of ["write", "maintenance"] as const) {
      const blocked = await runNativeLeaseCompetitor(fixture, alias, mode);
      console.info("NATIVE FTS competing lease", { mode, ...blocked });
      expect(blocked.acquired).toBe(false);
      expect(blocked.error).toMatch(/busy|locked|lease|owner/i);
    }
  } finally {
    pause.release();
    await starting;
  }
  expect(readAgentDatabaseAdmissionRefusal("main", { env: fixture.env })).toBeUndefined();
  expect(readStartupMigrationWarning()).toContain("Rebuilt stale SQLite FTS indexes");
  using db = openRawDatabase(alias, { readOnly: true });
  expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(db.prepare("SELECT rowid, * FROM session_transcript_fts").all()).toEqual(fixture.rows);
  // Startup admission retains an idle native writer until the normal lifecycle drain.
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  expect(await runNativeLeaseCompetitor(fixture, alias, "write")).toEqual({ acquired: true });
  expect(await runNativeLeaseCompetitor(fixture, alias, "maintenance")).toEqual({ acquired: true });
});

async function runNativeLeaseCompetitor(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  alias: string,
  mode: "write" | "maintenance",
): Promise<{ acquired: boolean; error?: string }> {
  const script = path.join(path.dirname(fixture.pathname), "native-lease-competitor.mjs");
  const result = script + "." + mode + ".json";
  fs.writeFileSync(
    script,
    [
      "import fs from 'node:fs';",
      "import { claimOpenClawAgentDatabaseLease, releaseOpenClawAgentDatabaseLease, AGENT_DATABASE_MAINTENANCE_LEASE, assertNoOpenClawAgentDatabaseLeases } from " +
        JSON.stringify(new URL("./openclaw-agent-db-lease.ts", import.meta.url).href) +
        ";",
      "import { runWithOpenClawStateBusyTimeout } from " +
        JSON.stringify(new URL("./openclaw-state-db.ts", import.meta.url).href) +
        ";",
      "import { withOpenClawStateLease } from " +
        JSON.stringify(new URL("./openclaw-state-lease.ts", import.meta.url).href) +
        ";",
      "const env = process.env; let acquired = false; let error;",
      "try {",
      "if (process.argv[2] === 'write') {",
      "const lease = runWithOpenClawStateBusyTimeout(() => claimOpenClawAgentDatabaseLease({agentId:'alias',path:process.argv[3],env}), {env}, 25);",
      "acquired = true; releaseOpenClawAgentDatabaseLease(lease,{env});",
      "} else {",
      "await withOpenClawStateLease({...AGENT_DATABASE_MAINTENANCE_LEASE, database:{scope:'shared',schemaPolicy:'existing',options:{env}},waitMs:0,leaseMs:60000,heartbeat:'worker'}, async owner => {assertNoOpenClawAgentDatabaseLeases(owner,{env}); acquired=true;});",
      "}",
      "} catch (cause) { error = String(cause); }",
      "fs.writeFileSync(process.argv[4], JSON.stringify({acquired,...(error ? {error} : {})})); process.exit(0);",
    ].join("\n"),
  );
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      [
        "--import",
        new URL("../../scripts/tsx.mjs", import.meta.url).pathname,
        script,
        mode,
        alias,
        result,
      ],
      {
        env: { ...process.env, ...fixture.env },
        timeout: 15000,
      },
      (error) =>
        error ? reject(new Error("Native lease competitor failed", { cause: error })) : resolve(),
    );
  });
  return JSON.parse(fs.readFileSync(result, "utf8")) as { acquired: boolean; error?: string };
}
