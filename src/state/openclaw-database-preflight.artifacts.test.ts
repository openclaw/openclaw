import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureTargetDatabaseSchemaContext,
  checkTargetDatabaseSchemasForContexts,
} from "../cli/update-cli/schema-preflight.js";
import { startSqliteConcurrentWriter } from "../infra/sqlite-concurrent-writer.test-support.js";
import { readMainDatabasePosixLocks } from "../infra/sqlite-posix-locks.test-support.js";
import { tryInspectSqliteReadOnlyInProcess } from "../infra/sqlite-readonly-inspection.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { withArtifactPreservingStateReads } from "./artifact-preserving-state-reads.js";
import {
  compatible,
  databaseFixture,
  closeDatabases,
  openRawDatabase,
  rejectSnapshot,
  supportedVersions,
  failureRow,
} from "./database-preflight-fixtures.test-support.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "./openclaw-agent-db-registry.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    closeDatabases();
    cleanup();
  });
});

beforeEach(() => {
  vi.stubEnv("XDG_CACHE_HOME", tempDirs.make("openclaw-preflight-snapshots-"));
});

function createFixture() {
  const base = databaseFixture(tempDirs.make("openclaw-preflight-artifacts-"));
  const state = base.state();
  const main = base.agent();
  const worker = base.agent("worker");
  return {
    ...base,
    state,
    main,
    worker,
    paths: [state.path, main.path, worker.path],
    inspect: (options: Parameters<typeof base.inspect>[0] = {}) =>
      base.inspect({ supportedVersions, ...options }),
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

it("retains the source-reader lock tolerance beyond the runtime busy timeout", async () => {
  const root = tempDirs.make("openclaw-header-lock-tolerance-");
  const active = databaseFixture(path.join(root, "active-state"));
  active.state();
  closeOpenClawStateDatabaseForTest();
  const pathname = path.join(root, "agent.sqlite");
  using writer = openRawDatabase(pathname);
  writer.exec(`
      CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, app_version TEXT, role TEXT, schema_version INTEGER, agent_id TEXT);
      INSERT INTO schema_meta VALUES ('primary', 'before-lock', 'agent', ${supportedVersions.agent}, 'main');
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
    const result = await active.inspect({
      supportedVersions,
      configuredAgentDatabaseCandidatePaths: [pathname],
    });
    expect(result).toEqual(compatible);
    expect(released).toBe(true);
  } finally {
    clearTimeout(release);
    if (writer.isTransaction) {
      writer.exec("ROLLBACK;");
    }
  }
}, 20_000);

it("unions native locators and aliases without dropping distinct stores", async () => {
  const fixture = createFixture();
  fixture.worker.db.exec(`PRAGMA user_version = ${supportedVersions.agent + 10};`);
  const registration = { agentId: "worker", path: fixture.worker.path, env: fixture.env };
  unregisterOpenClawAgentDatabase(registration);
  const link = path.join(fixture.env.OPENCLAW_STATE_DIR, "worker-link");
  fs.symlinkSync(path.dirname(fixture.worker.path), link, "dir");
  const locator = `${link}${path.sep}..${path.sep}agent${path.sep}openclaw-agent.sqlite`;
  registerOpenClawAgentDatabase({ ...registration, path: locator });
  fixture.close();
  const lexicalPath = path.resolve(locator);
  fs.mkdirSync(path.dirname(lexicalPath), { recursive: true });
  fs.copyFileSync(fixture.main.path, lexicalPath, fs.constants.COPYFILE_EXCL);
  expect(fs.realpathSync.native(locator)).toBe(fs.realpathSync.native(fixture.worker.path));
  expect(fs.realpathSync(locator)).toBe(fs.realpathSync.native(lexicalPath));
  const caller = databaseFixture(tempDirs.make("openclaw-preflight-caller-"));
  const callerStatePath = caller.state().path;
  closeOpenClawStateDatabaseForTest();
  const contexts = [
    { env: fixture.env, config: {} },
    { env: caller.env, config: { session: { store: lexicalPath } } },
    { env: caller.env, config: { session: { store: fixture.worker.path } } },
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

it("inspects incompatible agent schemas while an independent WAL writer keeps committing", async () => {
  const fixture = createFixture();
  const foundVersion = supportedVersions.agent + 1;
  // A 64 MiB source makes each byte-copy attempt overlap real commits.
  fixture.main.db.exec(`
        CREATE TABLE payloads (value BLOB NOT NULL) STRICT;
        WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM rows WHERE n < 1024)
        INSERT INTO payloads SELECT zeroblob(65536) FROM rows;
        CREATE TABLE writes (sequence INTEGER PRIMARY KEY);
        PRAGMA user_version = ${foundVersion};
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
      () => fixture.inspect(),
      () =>
        fixture.inspect({
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
      expect(result.incompatible).toEqual([
        expect.objectContaining({ kind: "agent", path: fixture.main.path, foundVersion }),
      ]);
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

// A Gateway-like owner in its own process. "churn" commits 128 KiB batches with SQLite's
// default WAL auto-checkpoint, so the WAL restarts while a byte copy runs. "idle" commits a
// newer schema only to the WAL, then holds the connection open without writing.
const agentOwner = `
  const { DatabaseSync } = require("node:sqlite");
  const [file, mode, version] = process.argv.slice(1);
  const database = new DatabaseSync(file);
  database.exec("PRAGMA busy_timeout = 30000; PRAGMA journal_mode = WAL");
  let running = true;
  let commits = 0;
  process.on("message", (message) => {
    if (message === "commits") process.send({ commits });
    else running = false;
  });
  if (mode === "idle") {
    database.exec("PRAGMA wal_autocheckpoint = 0; PRAGMA user_version = " + version);
    process.send("ready");
  }
  const insert = database.prepare("INSERT INTO churn (value) VALUES (randomblob(16384))");
  const trim = database.prepare("DELETE FROM churn WHERE rowid < (SELECT max(rowid) - 512 FROM churn)");
  (function batch() {
    if (!running) { database.close(); process.disconnect(); return; }
    if (mode === "idle") { setTimeout(batch, 20); return; }
    database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 8; index += 1) insert.run();
    if (commits % 16 === 0) trim.run();
    database.exec("COMMIT");
    commits += 1;
    if (commits === 1) process.send("ready");
    setImmediate(batch);
  })();
`;

async function withAgentOwner(
  file: string,
  mode: "churn" | "idle",
  version: number,
  run: (commits: () => Promise<number>) => Promise<void>,
) {
  const owner = spawn(
    process.execPath,
    ["--input-type=commonjs", "-e", agentOwner, file, mode, String(version)],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const closed = new Promise((resolve) => {
    owner.once("close", resolve);
  });
  try {
    await new Promise((resolve, reject) => {
      owner.once("message", resolve);
      owner.once("close", reject);
    });
    await run(
      () =>
        new Promise((resolve) => {
          owner.once("message", (reply: { commits: number }) => resolve(reply.commits));
          owner.send("commits");
        }),
    );
  } finally {
    if (owner.connected) {
      owner.send("stop");
    }
    await closed;
  }
}

// Candidate admission preserves source artifacts for every store it reads. A live agent
// store must be read in place: its private copy costs its full size and never stabilizes.
async function admitPreservingArtifacts(env: NodeJS.ProcessEnv, livePath: string) {
  const copies = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation");
  const result = await withArtifactPreservingStateReads(() =>
    checkTargetDatabaseSchemasForContexts(supportedVersions, [{ env, config: {} }]),
  );
  expect(copies.mock.calls.map(([source]) => source)).not.toContain(
    fs.realpathSync.native(livePath),
  );
  return result;
}

function agentFixture(version: number, payloadMiB = 0) {
  const fixture = createFixture();
  fixture.main.db.exec(`
        CREATE TABLE payloads (value BLOB NOT NULL) STRICT;
        WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM rows WHERE n < ${payloadMiB * 16})
        INSERT INTO payloads SELECT zeroblob(65536) FROM rows;
        CREATE TABLE churn (value BLOB NOT NULL);
        PRAGMA user_version = ${version};
      `);
  fixture.close();
  return fixture;
}

it("admits a live agent store's schema without a stable copy while it keeps checkpointing", async () => {
  const foundVersion = supportedVersions.agent + 1;
  const fixture = agentFixture(foundVersion, 32);
  const stateBefore = sourceArtifacts([fixture.state.path]);
  await withAgentOwner(fixture.main.path, "churn", foundVersion, async (commits) => {
    const before = await commits();
    expect(await admitPreservingArtifacts(fixture.env, fixture.main.path)).toEqual({
      incompatible: [
        expect.objectContaining({ kind: "agent", path: fixture.main.path, foundVersion }),
      ],
      indeterminate: [],
    });
    // The owner kept committing (and checkpointing) across the check.
    expect(await commits()).toBeGreaterThan(before);
  });
  expect(sourceArtifacts([fixture.state.path])).toEqual(stateBefore);
}, 60_000);

it("refuses a newer schema committed only to an open WAL without changing a source byte", async () => {
  const foundVersion = supportedVersions.agent + 1;
  const fixture = agentFixture(supportedVersions.agent);
  await withAgentOwner(fixture.main.path, "idle", foundVersion, async () => {
    const before = sourceArtifacts(fixture.paths);
    expect(await admitPreservingArtifacts(fixture.env, fixture.main.path)).toEqual({
      incompatible: [
        expect.objectContaining({ kind: "agent", path: fixture.main.path, foundVersion }),
      ],
      indeterminate: [],
    });
    // No reader mark is masked: the read-only index leaves -shm untouched as well.
    expect(sourceArtifacts(fixture.paths)).toEqual(before);
  });
}, 60_000);

// Hold the first committed WAL family until the reader is ready, then repeatedly close
// the last connection while the reader may be opening it.
const closingOwner = `
  const { DatabaseSync } = require("node:sqlite");
  const file = process.argv[1];
  let running = true;
  const held = new DatabaseSync(file);
  held.exec("PRAGMA busy_timeout = 2000; INSERT OR REPLACE INTO owner_cycles VALUES (1)");
  process.once("message", (command) => {
    held.close();
    if (command !== "start") { process.disconnect(); return; }
    process.once("message", () => { running = false; });
    cycle();
  });
  process.send("ready");
  function cycle() {
    if (!running) { process.disconnect(); return; }
    const database = new DatabaseSync(file);
    database.exec("PRAGMA busy_timeout = 2000; INSERT OR REPLACE INTO owner_cycles VALUES (1)");
    database.close();
    setImmediate(cycle);
  }
`;

it("reads a held WAL family and requests a private snapshot after its last owner closes", async () => {
  const root = tempDirs.make("openclaw-preflight-close-race-");
  const file = path.join(root, "agent.sqlite");
  {
    using database = openRawDatabase(file);
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE owner_cycles (id INTEGER PRIMARY KEY);
      PRAGMA user_version = ${supportedVersions.agent};
    `);
  }
  const owner = spawn(process.execPath, ["--input-type=commonjs", "-e", closingOwner, file], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    owner.once("error", reject);
    owner.once("close", resolve);
  });
  const inspect = () =>
    tryInspectSqliteReadOnlyInProcess(
      file,
      (database) => database.prepare("PRAGMA user_version").get(),
      { preserveSourceArtifacts: true },
    );
  try {
    await new Promise((resolve, reject) => {
      owner.once("message", resolve);
      owner.once("error", reject);
      owner.once("close", () => reject(new Error("SQLite owner closed before readiness")));
    });
    expect(inspect()?.value).toEqual({ user_version: supportedVersions.agent });
    owner.send("start");
    // Either result is valid during the race; scheduling need not produce both.
    for (let read = 0; read < 300; read += 1) {
      const inspection = inspect();
      if (inspection) {
        expect(inspection.value).toEqual({ user_version: supportedVersions.agent });
      }
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
  } finally {
    if (owner.connected) {
      owner.send("stop");
    }
    expect(await closed).toBe(0);
  }
  expect(inspect()).toBeUndefined();
}, 60_000);

it("ignores uncommitted writer versions without ending the owning transactions", async () => {
  const fixture = createFixture();
  const databases = [fixture.state, fixture.main, fixture.worker];
  for (const opened of databases) {
    opened.db.exec("BEGIN IMMEDIATE; PRAGMA user_version = 999;");
  }
  try {
    const allowReadMarks = fixture.paths;
    const before = sourceArtifacts(fixture.paths, allowReadMarks);
    const locks = process.platform === "linux" ? fixture.paths.map(readMainDatabasePosixLocks) : [];
    expect(
      await checkTargetDatabaseSchemasForContexts(supportedVersions, [
        await captureTargetDatabaseSchemaContext(fixture.env),
      ]),
    ).toEqual(compatible);
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
  "fails closed when the %s snapshot cannot be prepared",
  async (kind) => {
    const fixture = createFixture();
    fixture.close();
    const before = sourceArtifacts(fixture.paths);
    rejectSnapshot(fixture[kind].path, "inert snapshot admission failure");
    const result = await fixture.inspect({
      verifyCurrentSchemaShape: true,
      preserveSourceArtifacts: true,
    });
    expect(result).toMatchObject({
      incompatible: [],
      indeterminate: [
        failureRow(
          kind === "state" ? "state" : "agent",
          fixture[kind].path,
          "inert snapshot admission failure",
        ),
      ],
    });
    expect(sourceArtifacts(fixture.paths)).toEqual(before);
  },
);
