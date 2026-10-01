import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureTargetDatabaseSchemaContext,
  checkTargetDatabaseSchemasForContexts,
} from "../cli/update-cli/schema-preflight.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { startSqliteConcurrentWriter } from "../infra/sqlite-concurrent-writer.test-support.js";
import { readMainDatabasePosixLocks } from "../infra/sqlite-posix-locks.test-support.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "./openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const supportedVersions = {
  state: OPENCLAW_STATE_SCHEMA_VERSION,
  agent: OPENCLAW_AGENT_SCHEMA_VERSION,
};

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

beforeEach(() => {
  vi.stubEnv("XDG_CACHE_HOME", tempDirs.make("openclaw-preflight-snapshots-"));
});

function createFixture() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-preflight-artifacts-") };
  const state = openOpenClawStateDatabase({ env });
  const main = openOpenClawAgentDatabase({ agentId: "main", env });
  const worker = openOpenClawAgentDatabase({ agentId: "worker", env });
  return {
    env,
    state,
    main,
    worker,
    paths: [state.path, main.path, worker.path],
    close() {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
    },
  };
}

function sourceArtifacts(paths: string[], allowReadMarks: string[] = []): unknown {
  // Observe in a child too: opening/closing these in the writer's process can
  // itself release POSIX locks and would invalidate the writer-isolation probe.
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
       const allowReadMarks = JSON.parse(process.argv[1]);
       const record = file => {
         const s = fs.statSync(file, { bigint: true });
         const readMarks = allowReadMarks.some(database => file === database + '-shm');
         const bytes = s.isFile() ? fs.readFileSync(file) : undefined;
         if (readMarks) bytes.fill(0, 100, 120);
         return { file, mode: String(s.mode), dev: String(s.dev), ino: String(s.ino),
           size: String(s.size),
           ...(!readMarks ? { mtime: String(s.mtimeNs), ctime: String(s.ctimeNs) } : {}),
           ...(bytes ? { hash: crypto.createHash('sha256').update(bytes).digest('hex') }
             : { entries: fs.readdirSync(file).sort() }) };
       };
       console.log(JSON.stringify(process.argv.slice(2).map(file => ({
         directory: record(path.dirname(file)),
         family: ['', '-wal', '-shm', '-journal'].map(suffix => file + suffix)
           .filter(fs.existsSync).map(record)
       }))));`,
      JSON.stringify(allowReadMarks),
      ...paths,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("schema preflight source artifacts", () => {
  it("retains the source-reader lock tolerance beyond the runtime busy timeout", async () => {
    const root = tempDirs.make("openclaw-header-lock-tolerance-");
    const env = { OPENCLAW_STATE_DIR: path.join(root, "active-state") };
    openOpenClawStateDatabase({ env });
    closeOpenClawStateDatabaseForTest();
    const pathname = path.join(root, "agent.sqlite");
    const writer = new (requireNodeSqlite().DatabaseSync)(pathname);
    writer.exec(`
      CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, app_version TEXT);
      INSERT INTO schema_meta VALUES ('primary', 'before-lock');
      PRAGMA user_version = ${supportedVersions.agent};
      BEGIN EXCLUSIVE;
      UPDATE schema_meta SET app_version = 'after-lock';
    `);
    let released = false;
    const release = setTimeout(() => {
      writer.exec("COMMIT;");
      released = true;
    }, 8_000);
    try {
      const result = await preflightOpenClawDatabaseSchemas({
        env,
        supportedVersions,
        configuredAgentDatabaseCandidatePaths: [pathname],
      });
      expect(result).toEqual({ incompatible: [], indeterminate: [] });
      expect(released).toBe(true);
    } finally {
      clearTimeout(release);
      if (writer.isTransaction) {
        writer.exec("ROLLBACK;");
      }
      writer.close();
    }
  }, 20_000);

  it("unions native locators and aliases without dropping distinct stores", async () => {
    const fixture = createFixture();
    fixture.worker.db.exec(`PRAGMA user_version = ${supportedVersions.agent + 10};`);
    unregisterOpenClawAgentDatabase({
      agentId: "worker",
      path: fixture.worker.path,
      env: fixture.env,
    });
    const link = path.join(fixture.env.OPENCLAW_STATE_DIR, "worker-link");
    fs.symlinkSync(path.dirname(fixture.worker.path), link, "dir");
    const locator = `${link}${path.sep}..${path.sep}agent${path.sep}openclaw-agent.sqlite`;
    registerOpenClawAgentDatabase({ agentId: "worker", path: locator, env: fixture.env });
    fixture.close();
    const lexicalPath = path.resolve(locator);
    fs.mkdirSync(path.dirname(lexicalPath), { recursive: true });
    fs.copyFileSync(fixture.main.path, lexicalPath, fs.constants.COPYFILE_EXCL);
    expect(fs.realpathSync.native(locator)).toBe(fs.realpathSync.native(fixture.worker.path));
    expect(fs.realpathSync(locator)).toBe(fs.realpathSync.native(lexicalPath));
    const callerEnv = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-preflight-caller-") };
    const callerStatePath = openOpenClawStateDatabase({ env: callerEnv }).path;
    closeOpenClawStateDatabaseForTest();
    const contexts = [
      { env: fixture.env, config: {} },
      { env: callerEnv, config: { session: { store: lexicalPath } } },
      { env: callerEnv, config: { session: { store: fixture.worker.path } } },
    ];
    const paths = [...fixture.paths, callerStatePath, lexicalPath];
    const before = sourceArtifacts(paths);
    const result = await checkTargetDatabaseSchemasForContexts(
      { ...supportedVersions, agent: supportedVersions.agent - 1 },
      contexts,
    );
    expect(result.indeterminate).toEqual([]);
    expect(
      result.incompatible.map((database) => fs.realpathSync.native(database.path)).toSorted(),
    ).toEqual([fixture.main.path, fixture.worker.path, lexicalPath].toSorted());
    expect(
      result.incompatible.find((database) => database.foundVersion === supportedVersions.agent + 10)
        ?.path,
    ).toBe(locator);
    expect(sourceArtifacts(paths)).toEqual(before);
  });

  it("reads newer live WAL schemas without changing contents beyond agent SHM read marks", async () => {
    const fixture = createFixture();
    fixture.state.db.exec(`PRAGMA user_version = ${supportedVersions.state + 10};`);
    fixture.main.db.exec(`PRAGMA user_version = ${supportedVersions.agent + 10};`);
    fixture.worker.db.exec(`PRAGMA user_version = ${supportedVersions.agent + 10};`);
    // SQLite's WAL-index read-mark array occupies bytes 100..119 of SHM.
    const allowReadMarks = [fixture.main.path, fixture.worker.path];
    const before = sourceArtifacts(fixture.paths, allowReadMarks);
    let eventLoopServiced = false;
    const immediate = setImmediate(() => {
      eventLoopServiced = true;
    });
    try {
      const result = await preflightOpenClawDatabaseSchemas({
        env: fixture.env,
        supportedVersions,
        verifyCurrentSchemaShape: true,
      });
      expect(eventLoopServiced).toBe(true);
      expect(result.indeterminate).toEqual([]);
      expect(
        result.incompatible.map(({ path: pathname, foundVersion }) => [pathname, foundVersion]),
      ).toEqual([
        [fixture.state.path, supportedVersions.state + 10],
        [fixture.main.path, supportedVersions.agent + 10],
        [fixture.worker.path, supportedVersions.agent + 10],
      ]);
      expect(sourceArtifacts(fixture.paths, allowReadMarks)).toEqual(before);
    } finally {
      clearImmediate(immediate);
      fixture.state.db.exec(`PRAGMA user_version = ${supportedVersions.state};`);
      fixture.main.db.exec(`PRAGMA user_version = ${supportedVersions.agent};`);
      fixture.worker.db.exec(`PRAGMA user_version = ${supportedVersions.agent};`);
    }
  });

  it("inspects agent schemas while an independent WAL writer keeps committing", async () => {
    const fixture = createFixture();
    // A 64 MiB source makes each byte-copy attempt overlap real commits.
    fixture.main.db.exec(`
        CREATE TABLE payloads (value BLOB NOT NULL) STRICT;
        WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM rows WHERE n < 1024)
        INSERT INTO payloads SELECT zeroblob(65536) FROM rows;
        CREATE TABLE writes (sequence INTEGER PRIMARY KEY);
      `);
    fixture.close();
    const mainHash = () =>
      createHash("sha256").update(fs.readFileSync(fixture.main.path)).digest("hex");
    const mainBefore = mainHash();
    const stateBefore = sourceArtifacts([fixture.state.path]);
    const writer = startSqliteConcurrentWriter(fixture.main.path, "WAL");
    try {
      await writer.waitFor("ready");
      const walBefore = fs.readFileSync(`${fixture.main.path}-wal`);
      for (const inspect of [
        () => preflightOpenClawDatabaseSchemas({ env: fixture.env, supportedVersions }),
        () =>
          preflightOpenClawDatabaseSchemas({
            env: fixture.env,
            supportedVersions,
            verifyCurrentSchemaShape: true,
            requireStartupMigrationReadiness: true,
          }),
        () =>
          checkTargetDatabaseSchemasForContexts(supportedVersions, [
            { env: fixture.env, config: {} },
          ]),
      ]) {
        const { commits } = await writer.progress();
        const result = await inspect();
        expect((await writer.progress()).commits).toBeGreaterThan(commits);
        expect(result.indeterminate).toEqual([]);
        expect(result.incompatible).toEqual([]);
      }
      // The writer appends WAL frames. Inspection must not checkpoint the main
      // database or rewrite any preexisting WAL bytes while those commits run.
      expect(mainHash()).toBe(mainBefore);
      const wal = fs.openSync(`${fixture.main.path}-wal`, "r");
      try {
        const prefix = Buffer.alloc(walBefore.length);
        expect(fs.readSync(wal, prefix, 0, prefix.length, 0)).toBe(prefix.length);
        expect(prefix).toEqual(walBefore);
      } finally {
        fs.closeSync(wal);
      }
      expect(sourceArtifacts([fixture.state.path])).toEqual(stateBefore);
    } finally {
      await writer.stop();
    }
  }, 30_000);

  it("ignores uncommitted writer versions without ending the owning transactions", async () => {
    const fixture = createFixture();
    const databases = [fixture.state, fixture.main, fixture.worker];
    for (const opened of databases) {
      opened.db.exec("BEGIN IMMEDIATE; PRAGMA user_version = 999;");
    }
    try {
      const allowReadMarks = [fixture.main.path, fixture.worker.path];
      const before = sourceArtifacts(fixture.paths, allowReadMarks);
      const locks =
        process.platform === "linux" ? fixture.paths.map(readMainDatabasePosixLocks) : [];
      expect(
        await checkTargetDatabaseSchemasForContexts(supportedVersions, [
          await captureTargetDatabaseSchemaContext(fixture.env),
        ]),
      ).toEqual({ incompatible: [], indeterminate: [] });
      expect(sourceArtifacts(fixture.paths, allowReadMarks)).toEqual(before);
      for (const opened of databases) {
        expect(opened.db.isTransaction).toBe(true);
        expect(opened.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 999 });
      }
      if (process.platform === "linux") {
        expect(locks.every((held) => held.length > 0)).toBe(true);
        expect(fixture.paths.map(readMainDatabasePosixLocks)).toEqual(locks);
      }
    } finally {
      for (const opened of databases) {
        opened.db.exec("ROLLBACK");
      }
    }
  });

  it.each(["state", "main"] as const)(
    "cleans the %s snapshot when its private open fails",
    async (kind) => {
      const fixture = createFixture();
      fixture.close();
      const before = sourceArtifacts(fixture.paths);
      const prepare = snapshots.prepareSqliteReadOnlyLocation;
      const cleanups: Array<{ location: string; cleanup: ReturnType<typeof vi.fn> }> = [];
      vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(
        async (pathname, options) => {
          const prepared = await prepare(pathname, options);
          const cleanup = vi.fn(prepared.cleanupAsync);
          cleanups.push({ location: prepared.location, cleanup });
          return {
            ...prepared,
            location:
              pathname === fixture[kind].path
                ? path.join(path.dirname(prepared.location), "missing.sqlite")
                : prepared.location,
            cleanupAsync: cleanup,
          };
        },
      );
      const result = await preflightOpenClawDatabaseSchemas({
        env: fixture.env,
        supportedVersions,
        verifyCurrentSchemaShape: true,
      });
      expect(result.indeterminate).toEqual([
        expect.objectContaining({
          kind: kind === "state" ? "state" : "agent",
          path: fixture[kind].path,
        }),
      ]);
      expect(cleanups.length).toBe(kind === "state" ? 1 : 3);
      for (const { location, cleanup } of cleanups) {
        expect(cleanup).toHaveBeenCalledOnce();
        expect(fs.existsSync(path.dirname(location))).toBe(false);
      }
      expect(sourceArtifacts(fixture.paths)).toEqual(before);
    },
  );
});
