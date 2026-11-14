import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  readSqliteDatabaseCleanClose,
  revokeSqliteDatabaseAdmissionsForPath,
  readSqliteDatabaseIntegrityVerification,
} from "../infra/sqlite-database-admission.js";
import { readStableSqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import { assertSqliteDatabaseHeader } from "../infra/sqlite-integrity.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { createPermitPool } from "../shared/permit-pool.js";
import { assertAgentDatabaseAdmitted } from "./agent-database-admission.js";
import {
  captureAgentDatabaseStartupIntegrity,
  prepareAgentDatabaseStartupVerification as prepareStartupVerification,
} from "./agent-database-startup-integrity.js";
import { verifyAgentDatabaseStartupIntegrity } from "./agent-database-startup-verification.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import { recordOpenClawAgentDatabaseOpenFailure } from "./openclaw-agent-db-lifecycle.js";
import {
  clearOpenClawAgentDatabaseOpenFailure,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { prepareOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";
import {
  clearOpenClawDatabaseQuarantine,
  readOpenClawDatabaseQuarantineFailure,
  recordOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.js";
import {
  readPersistedQuarantineRow,
  seedOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.test-support.js";
import { recordOpenClawStateDatabaseOpenFailure } from "./openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
    using teardown = new DisposableStack();
    teardown.defer(cleanup);
    teardown.defer(closeOpenClawStateDatabaseForTest);
    teardown.defer(closeOpenClawAgentDatabasesForTest);
  });
});

function fixture() {
  const stateDir = tempDirs.make("openclaw-database-verify-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const databasePath = path.join(stateDir, "agent.sqlite");
  return {
    env,
    databasePath,
    storePath: path.join(stateDir, "state", "openclaw-quarantine.sqlite"),
    agent: () => openOpenClawAgentDatabase({ agentId: "worker-1", env }),
    state: () => openOpenClawStateDatabase({ env }),
    read: () => readOpenClawDatabaseQuarantineFailure("agent", databasePath, { env }),
    row: (pathname = databasePath) => readPersistedQuarantineRow(pathname, { env }),
    clear: (pathname = databasePath) => clearOpenClawDatabaseQuarantine(pathname, { env }),
    seed: (pathname = databasePath, reason = "corrupt index", kind: "agent" | "state" = "agent") =>
      seedOpenClawDatabaseQuarantine({ env, kind, path: pathname, reason }),
  };
}

function integrityError(message = "corrupt index") {
  return Object.assign(new Error(message), { name: "SqliteIntegrityError" });
}

const corrupt = expect.stringContaining("corrupt index");
const damage = expect.objectContaining({ name: "SqliteIntegrityError", message: corrupt });
const timestamp = expect.any(Number);

function execDatabase(pathname: string, sql: string) {
  using database = openDatabase(pathname);
  database.exec(sql);
}

function openDatabase(pathname: string, readOnly = false) {
  return new (requireNodeSqlite().DatabaseSync)(pathname, { readOnly });
}

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
it("revalidates a latched integrity failure after external repair", () => {
  const agentPath = f.agent().path;
  closeOpenClawAgentDatabasesForTest();
  recordOpenClawAgentDatabaseOpenFailure(agentPath, integrityError("corrupt generation"));
  execDatabase(agentPath, "CREATE TABLE generation_change (id INTEGER PRIMARY KEY) STRICT;");

  expect(f.agent().db.isOpen).toBe(true);
});

it("retains a recorded corruption verdict across writes until verified Doctor recovery", () => {
  const database = f.agent();
  expect(
    readOpenClawDatabaseQuarantineFailure("agent", database.path, { env: f.env }),
  ).toBeUndefined();
  recordOpenClawDatabaseQuarantine(database.path, "corrupt index", {
    env: f.env,
    assertCurrent() {},
  });
  database.db.exec("CREATE TABLE later_write (id INTEGER PRIMARY KEY) STRICT");
  expect(
    readOpenClawDatabaseQuarantineFailure("agent", database.path, { env: f.env }),
  ).toMatchObject(damage);
  closeOpenClawAgentDatabasesForTest();
  expect(f.agent).toThrow(damage);
  expect(clearOpenClawAgentDatabaseOpenFailure(database.path, { env: f.env })).toBe(true);
  expect(f.agent().db.isOpen).toBe(true);
});

it("rejects an impossible freelist header without a full database scan", () => {
  const database = openDatabase(f.databasePath);
  database.exec("CREATE TABLE probe(id INTEGER PRIMARY KEY)");
  assertSqliteDatabaseHeader(database, f.databasePath);
  database.close();
  const bytes = fs.readFileSync(f.databasePath);
  bytes.writeUInt32BE(0xffff_ffff, 36);
  fs.writeFileSync(f.databasePath, bytes);
  using damaged = openDatabase(f.databasePath, true);
  expect(() => assertSqliteDatabaseHeader(damaged, f.databasePath)).toThrow(
    /header is inconsistent|malformed/iu,
  );
});

it("binds provisional startup admission to its original lifetime and physical file", () => {
  const { path: file, agentId } = f.agent();
  const input = { agentId, paths: [file], env: f.env, signal: new AbortController().signal };
  const activation = { isCurrent: () => true, verifyIntegrity: async () => {} };
  const owner = prepareStartupVerification(input, activation, createPermitPool(1))!;
  const policy = captureAgentDatabaseStartupIntegrity(file, agentId)!;
  expect(captureAgentDatabaseStartupIntegrity(file, "other")).toBeUndefined();
  owner.revoke();
  expect(Atomics.load(new Int32Array(policy.valid), 0)).toBe(0);
  using cleanup = new DisposableStack();
  cleanup.defer(prepareStartupVerification(input, activation, createPermitPool(1))!.revoke);
  owner.revoke();
  expect(captureAgentDatabaseStartupIntegrity(file, agentId)).toBeDefined();
  closeOpenClawAgentDatabasesForTest();
  fs.renameSync(file, `${file}.old`);
  using replacement = openDatabase(file);
  replacement.exec("CREATE TABLE replacement(id INTEGER PRIMARY KEY)");
  expect(() => captureAgentDatabaseStartupIntegrity(file, agentId)).toThrow(/identity changed/iu);
});

it("reports an uncleared quarantine row instead of claiming repair success", () => {
  const agentPath = f.agent().path;
  f.state();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  f.seed(agentPath);
  recordOpenClawAgentDatabaseOpenFailure(agentPath, integrityError());
  closeOpenClawStateDatabaseForTest();

  const before = f.row(agentPath);
  expect(before).toMatchObject({ kind: "agent", reason: "corrupt index" });
  {
    using quarantine = openDatabase(f.storePath);
    // chmod cannot refuse writes from root; fail the real SQLite writes instead.
    quarantine.exec(`
        CREATE TRIGGER refuse_quarantine_clear BEFORE DELETE ON quarantined_databases
        BEGIN SELECT RAISE(ABORT, 'quarantine store is read-only'); END;
      `);
    expect(clearOpenClawAgentDatabaseOpenFailure(agentPath, { env: f.env })).toBe(false);
    expect(f.row(agentPath)).toEqual(before);
    expect(f.clear(agentPath)).toBe(false);
    expect(f.row(agentPath)).toEqual(before);
    expect(f.agent).toThrow(damage);
    quarantine.exec("DROP TRIGGER refuse_quarantine_clear;");
  }
  expect(clearOpenClawAgentDatabaseOpenFailure(agentPath, { env: f.env })).toBe(true);
  expect(f.row(agentPath)).toBeUndefined();
  expect(f.agent().db.isOpen).toBe(true);
});

it("retains the quarantine history marker without storing integrity receipts", () => {
  const state = f.state();
  expect(f.row(state.path)).toBeUndefined();
  expect(fs.existsSync(f.storePath)).toBe(false);

  const agent = f.agent();
  expect(readSqliteDatabaseIntegrityVerification(agent.path)).toMatchObject({
    verifiedAt: expect.any(Number),
  });
  expect(f.row(agent.path)).toBeUndefined();
  using quarantine = openDatabase(f.storePath, true);
  expect(quarantine.prepare("SELECT * FROM agent_integrity_verifications").all()).toEqual([]);
});

it("clears historical quarantine rows with rollback journaling", () => {
  expect(f.clear()).toBe(true);
  f.seed();
  expect(f.row()).toEqual({ kind: "agent", quarantinedAt: timestamp, reason: "corrupt index" });

  {
    using raw = openDatabase(f.storePath, true);
    expect({
      ...raw.prepare("PRAGMA journal_mode").get(),
      synchronous: readSqliteNumberPragma(raw, "synchronous"),
      version: readSqliteNumberPragma(raw, "user_version"),
    }).toEqual({ journal_mode: "delete", synchronous: 2, version: 2 });
  }
  if (process.platform !== "win32") {
    expect(fs.statSync(path.dirname(f.storePath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(f.storePath).mode & 0o777).toBe(0o600);
  }
  expect(f.clear()).toBe(true);
  expect(f.clear()).toBe(true);
  expect(f.row()).toBeUndefined();
});

it("expires a persisted quarantine when the verified database generation changes", () => {
  const { env, databasePath } = f;
  execDatabase(databasePath, "CREATE TABLE records (id INTEGER PRIMARY KEY) STRICT;");
  const generation = readStableSqliteFileGeneration(databasePath);

  seedOpenClawDatabaseQuarantine({
    env,
    generation,
    kind: "agent",
    path: databasePath,
    reason: "corrupt generation",
  });
  const quarantineBefore = f.row();
  expect(quarantineBefore?.reason).toBe("corrupt generation");
  expect(f.read()).toMatchObject({ name: "SqliteIntegrityError" });

  execDatabase(databasePath, "INSERT INTO records DEFAULT VALUES;");
  expect(f.read()).toBeUndefined();
  expect(f.row()).toEqual(quarantineBefore);
});

it("reads schema-v1 quarantine rows and migrates them when clearing another path", () => {
  const { databasePath, storePath } = f;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  {
    using legacy = openDatabase(storePath);
    legacy.exec(`
        CREATE TABLE quarantined_databases (
          path TEXT NOT NULL PRIMARY KEY, kind TEXT NOT NULL, reason TEXT NOT NULL,
          quarantined_at INTEGER NOT NULL, writer_app_version TEXT
        ) STRICT;
        PRAGMA user_version = 1;
      `);
    legacy
      .prepare(
        "INSERT INTO quarantined_databases VALUES (?, 'agent', 'legacy quarantine', 1, NULL)",
      )
      .run(path.resolve(databasePath));
  }

  expect(f.row()).toEqual({ kind: "agent", quarantinedAt: 1, reason: "legacy quarantine" });
  expect(f.read()).toMatchObject({ name: "SqliteIntegrityError" });
  expect(f.clear(`${databasePath}.other`)).toBe(true);

  using migrated = openDatabase(storePath, true);
  expect(readSqliteNumberPragma(migrated, "user_version")).toBe(2);
  expect(
    migrated
      .prepare("SELECT reason, verified_generation FROM quarantined_databases WHERE path = ?")
      .get(path.resolve(databasePath)),
  ).toEqual({ reason: "legacy quarantine", verified_generation: null });
});

it("recovers an interrupted empty quarantine-store initialization", () => {
  fs.mkdirSync(path.dirname(f.storePath), { recursive: true });
  fs.writeFileSync(f.storePath, "", { mode: 0o600 });

  expect(f.read()).toBeUndefined();
  expect(f.clear()).toBe(true);
  f.seed();
  expect(f.row()?.reason).toBe("corrupt index");
});

it.skipIf(process.platform === "win32")(
  "recovers a hot rollback journal before reading quarantine",
  () => {
    f.seed(f.databasePath, "committed reason");

    const quarantineBefore = f.row();
    expect(quarantineBefore?.reason).toBe("committed reason");
    const crashed = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--input-type=module",
        "-e",
        `
            import { DatabaseSync } from "node:sqlite";
            const database = new DatabaseSync(process.env.OPENCLAW_QUARANTINE_TEST_PATH);
            database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
            database.prepare("UPDATE quarantined_databases SET reason = 'uncommitted reason'").run();
            process.kill(process.pid, "SIGKILL");
          `,
      ],
      { env: { ...process.env, OPENCLAW_QUARANTINE_TEST_PATH: f.storePath } },
    );
    expect(crashed.signal).toBe("SIGKILL");
    expect(fs.existsSync(`${f.storePath}-journal`)).toBe(true);

    expect(f.read()).toMatchObject({ name: "SqliteIntegrityError" });
    expect(f.row()).toEqual(quarantineBefore);
  },
);

it("persists state failure quarantine across restart until doctor repair", () => {
  const statePath = f.state().path;
  closeOpenClawStateDatabaseForTest();

  f.seed(statePath, "corrupt index", "state");
  recordOpenClawStateDatabaseOpenFailure(statePath, integrityError());

  expect(f.row(statePath)).toMatchObject({ kind: "state", reason: "corrupt index" });
  expect(f.state).toThrow(damage);
  closeOpenClawStateDatabaseForTest();
  expect(f.state).toThrow(damage);
  expect(repairOpenClawStateDatabaseSchema({ env: f.env }).warnings).toEqual([]);
  expect(f.state().db.isOpen).toBe(true);
});

it.each([false, true])(
  "admits unsealed startup before full verification, corruption=%s",
  async (damaged) => {
    const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("startup-proportionate-")) };
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    const config = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(config);
    const scope = { agentId: "main", env, sessionKey: "agent:main:retained" };
    await replaceSessionEntry(scope, { sessionId: "retained", updatedAt: 1 });
    const pathname = openOpenClawAgentDatabase(scope).path;
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    revokeSqliteDatabaseAdmissionsForPath(pathname);
    if (damaged) {
      using db = openDatabase(pathname);
      db.exec(
        "PRAGMA foreign_keys=OFF; CREATE TABLE integrity_parent(id INTEGER PRIMARY KEY); CREATE TABLE integrity_child(parent_id REFERENCES integrity_parent(id)); INSERT INTO integrity_child VALUES (42)",
      );
    }
    expect(readSqliteDatabaseIntegrityVerification(pathname)).toBeUndefined();
    await withAgentDatabaseStartupAdmission(async (admission) => {
      await assertOpenClawDatabasesReady({ env, config, operation: "gateway-startup" });
      const owner = admission.adopt();
      const verification = Promise.withResolvers<void>();
      try {
        admission.activate({
          isCurrent: () => true,
          preparationReady: Promise.resolve(),
          openAgent: ({ assertCurrent, signal }) =>
            prepareOpenClawAgentDatabaseExecution(scope, assertCurrent, signal),
          migrateAgent: async () => {},
          publishAgent: async () => {},
          verifyIntegrity: async (input) => {
            await verification.promise;
            await verifyAgentDatabaseStartupIntegrity(input);
          },
        });
        await admission.waitForAgentPreparation("main", { env, forWrite: true });
        expect(() => assertAgentDatabaseAdmitted("main", { env })).not.toThrow();
        expect(readSqliteDatabaseIntegrityVerification(pathname)).toBeUndefined();
        await replaceSessionEntry(scope, { sessionId: "retained", updatedAt: 2 });
        verification.resolve();
        await admission.pendingPreparation;
        if (damaged) {
          expect(() => assertAgentDatabaseAdmitted("main", { env })).toThrow(/foreign_key_check/);
          expect(
            readOpenClawDatabaseQuarantineFailure("agent", pathname, { env, fresh: true }),
          ).toMatchObject({ name: "SqliteIntegrityError" });
        } else {
          expect(readSqliteDatabaseIntegrityVerification(pathname)?.verifiedAt).toBeGreaterThan(0);
          await closeOpenClawAgentDatabasesAsync();
          expect(readSqliteDatabaseCleanClose(pathname)).toBe(true);
        }
      } finally {
        verification.resolve();
        await owner.stop();
      }
    });
  },
);
