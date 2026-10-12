import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import * as sqlite from "../infra/node-sqlite.js";
import { readSqliteDatabaseCleanClose } from "../infra/sqlite-database-admission.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import type { SqliteIntegrityDiagnostics } from "../infra/sqlite-integrity.js";
import {
  beginGatewayShutdownCleanup,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  claimOpenClawAgentDatabaseLease,
  invalidateOpenClawAgentDatabaseIntegrityBeforeMutation,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import { closeCachedOpenClawAgentDatabase } from "./openclaw-agent-db-lifecycle.js";
import * as schema from "./openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAdmission,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import * as verifier from "./openclaw-database-verify.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { resolveQuarantineStorePath } from "./openclaw-state-db.paths.js";
import { createUnsafeIndexDrift } from "./sqlite-index-drift.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const logger = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => {
      const original = actual.createSubsystemLogger(name);
      return name === "state/agent-db" ? { ...original, info: logger.info } : original;
    },
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  logger.info.mockClear();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it("certifies idle handles after grace and borrowed handles only after their final release", async () => {
  vi.useFakeTimers();
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-cleanup-idle-") };
  const options = { agentId: "idle", env };
  const heldOptions = { agentId: "held", env };
  const idle = openOpenClawAgentDatabase(options);
  const held = openOpenClawAgentDatabase(heldOptions);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const borrowed = withOpenClawAgentDatabaseAsync(heldOptions, async (database) => {
    entered.resolve();
    await release.promise;
    expect(database.db.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
  });
  try {
    await entered.promise;
    markGatewayRestartDraining();
    await vi.advanceTimersByTimeAsync(0);
    expect(idle.db.isOpen).toBe(true);
    beginGatewayShutdownCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(idle.db.isOpen).toBe(false);
    expect(readSqliteDatabaseCleanClose(idle.path)).toBe(true);
    expect(held.db.isOpen).toBe(true);
    expect(readSqliteDatabaseCleanClose(held.path)).toBe(false);
    release.resolve();
    await borrowed;
    await vi.advanceTimersByTimeAsync(0);
    expect(held.db.isOpen).toBe(false);
    expect(readSqliteDatabaseCleanClose(held.path)).toBe(true);
    await withOpenClawAgentDatabaseAsync(options, async (reopened) => {
      await Promise.resolve();
      expect(reopened.db.isOpen).toBe(true);
      reopened.db.exec("INSERT INTO auth_profile_state VALUES ('seal-reopen', '{}', 1)");
      expect(readSqliteDatabaseCleanClose(idle.path)).toBe(false);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(readSqliteDatabaseCleanClose(idle.path)).toBe(true);
  } finally {
    release.resolve();
    await borrowed;
    resetGatewayWorkAdmission();
    vi.useRealTimers();
  }
});

it("retains admission through pinned WAL eviction and certifies the final checkpointed close", async () => {
  const options = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-pinned-") },
  };
  const pathname = resolveOpenClawAgentSqlitePath(options);
  let checks = 0;
  const open = sqlite.openNodeSqliteDatabase;
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    if (args[0] === pathname) {
      const prepare = database.prepare.bind(database);
      vi.spyOn(database, "prepare").mockImplementation((sql) => {
        if (/^PRAGMA integrity_check(?:\('sqlite_schema'\))?;?$/.test(sql)) {
          checks += 1;
        }
        return prepare(sql);
      });
    }
    return database;
  });
  const worker = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
  const quickCheck = vi.spyOn(verifier, "requestOpenClawAgentDatabaseIntegrityCheck");
  const write = (updatedAt: number) =>
    runOpenClawAgentWriteTransaction(
      (database) =>
        writeSessionEntry(database, "agent:main:integrity", { sessionId: "retained", updatedAt }),
      options,
    );
  write(1);
  const reader = open(pathname, { readOnly: true });
  try {
    reader.exec("BEGIN");
    reader.prepare("SELECT updated_at FROM session_nodes").all();
    for (let iteration = 2; iteration <= 9; iteration += 1) {
      write(iteration);
      const database = openOpenClawAgentDatabase(options);
      closeCachedOpenClawAgentDatabase(database, { eviction: true });
      expect(database.walMaintenance.health?.state).toBe("blocked");
      expect(database.db.isOpen).toBe(false);
      await withOpenClawAgentDatabaseAsync(options, (reopened) => {
        expect(reopened.db.prepare("SELECT updated_at FROM session_nodes").get()).toEqual({
          updated_at: iteration,
        });
      });
    }
    expect(checks + worker.mock.calls.length).toBe(1);
    expect(quickCheck).not.toHaveBeenCalled();
  } finally {
    reader.close();
  }
  closeOpenClawAgentDatabasesForTest();
  expect(readSqliteDatabaseCleanClose(pathname)).toBe(true);
  openOpenClawAgentDatabase(options);
  expect(checks + worker.mock.calls.length).toBe(1);
  expect(quickCheck).not.toHaveBeenCalled();
});

it("checks once across writes and physical admitted reopens, including after lifecycle reset", async () => {
  const options = {
    agentId: "integrity-cache",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-cache-") },
  };
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const checks: string[] = [];
  const open = sqlite.openNodeSqliteDatabase;
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    if (args[0] === pathname) {
      const prepare = database.prepare.bind(database);
      vi.spyOn(database, "prepare").mockImplementation((sql) => {
        if (/^PRAGMA (integrity_check|foreign_key_check)(?:\('sqlite_schema'\))?;$/.test(sql)) {
          checks.push(sql);
        }
        return prepare(sql);
      });
    }
    return database;
  });
  const worker = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
  const quickCheck = vi.spyOn(verifier, "requestOpenClawAgentDatabaseIntegrityCheck");
  const first = openOpenClawAgentDatabase(options);
  expect(checks).toEqual(["PRAGMA integrity_check;", "PRAGMA foreign_key_check;"]);
  first.db.exec("INSERT INTO auth_profile_state VALUES ('preserved', '{\"value\":42}', 1)");
  for (let iteration = 0; iteration < 2; iteration += 1) {
    closeOpenClawAgentDatabaseByPath(pathname);
    const read = (database: typeof first) =>
      database.db
        .prepare("SELECT state_json FROM auth_profile_state WHERE state_key = ?")
        .get("preserved");
    const row = await withOpenClawAgentDatabaseAdmission(
      options,
      (run) => Promise.resolve(run(() => {})),
      read,
    );
    expect(row).toEqual({ state_json: '{"value":42}' });
  }
  expect(checks).toEqual(["PRAGMA integrity_check;", "PRAGMA foreign_key_check;"]);
  expect(worker).not.toHaveBeenCalled();
  expect(quickCheck).not.toHaveBeenCalled();

  closeOpenClawAgentDatabasesForTest();
  openOpenClawAgentDatabase(options);
  expect(checks).toEqual(["PRAGMA integrity_check;", "PRAGMA foreign_key_check;"]);
});

it("refuses an orphan allocated page before admitting a dirty database", async () => {
  const expected = /never used/iu;
  const options = {
    agentId: "integrity-pages",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-pages-") },
  };
  const pathname = openOpenClawAgentDatabase(options).path;
  closeOpenClawAgentDatabasesForTest();
  invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(pathname);
  const database = sqlite.openNodeSqliteDatabase(pathname);
  try {
    database.enableDefensive?.(false);
    database.exec(`
      CREATE TABLE page_owner_a (value INTEGER);
      CREATE TABLE page_owner_b (value INTEGER);
      INSERT INTO page_owner_a VALUES (1);
      INSERT INTO page_owner_b VALUES (2);
      PRAGMA writable_schema = ON;
    `);
    database.exec("DELETE FROM sqlite_schema WHERE name = 'page_owner_b';");
    const version = Number(database.prepare("PRAGMA schema_version").get()?.schema_version);
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${version + 1};`);

    // Every table can be sound while global page ownership is corrupt.
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all();
    for (const table of [{ name: "sqlite_schema" }, ...tables]) {
      const name = String(table.name).replaceAll("'", "''");
      expect(database.prepare(`PRAGMA integrity_check('${name}')`).all()).toEqual([
        { integrity_check: "ok" },
      ]);
    }
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(String(database.prepare("PRAGMA integrity_check").get()?.integrity_check)).toMatch(
      expected,
    );
  } finally {
    database.close();
  }

  const admitted = vi.fn();
  await expect(
    withOpenClawAgentDatabaseAdmission(options, (run) => Promise.resolve(run(() => {})), admitted),
  ).rejects.toMatchObject({
    name: "SqliteIntegrityError",
    message: expect.stringMatching(expected),
  });
  expect(admitted).not.toHaveBeenCalled();
});

it("does not lend remembered integrity to another file at the same path", () => {
  const options = {
    agentId: "integrity-cache",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-replacement-") },
  };
  const database = openOpenClawAgentDatabase(options);
  closeOpenClawAgentDatabaseByPath(database.path);
  const replacement = `${database.path}.replacement`;
  fs.copyFileSync(database.path, replacement);
  createUnsafeIndexDrift(replacement);
  fs.renameSync(replacement, database.path);
  expect(() => openOpenClawAgentDatabase(options)).toThrow(
    /integrity_check failed.*missing from index unsafe_index_records_value/iu,
  );
});

it("rechecks the media version guard after a validated handle is replaced by a populated v0 store", () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-media-replacement-") };
  const databasePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
  expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);

  fs.copyFileSync(databasePath, `${databasePath}.replacement`);
  fs.renameSync(`${databasePath}.replacement`, databasePath);
  const { DatabaseSync } = sqlite.requireNodeSqlite();
  const downgraded = new DatabaseSync(databasePath);
  try {
    downgraded.exec(`
      PRAGMA user_version = 0;
      UPDATE schema_meta SET schema_version = 0 WHERE meta_key = 'primary';
    `);
  } finally {
    downgraded.close();
  }

  expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
    "run openclaw doctor --fix to migrate persisted media",
  );
});

it.each(["invalid seal", "foreign lease"] as const)(
  "retains admitted physical proof despite an %s",
  (change) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-integrity-policy-") };
    const options = { agentId: "policy", env };
    const original = openOpenClawAgentDatabase(options);
    original.db.exec("INSERT INTO auth_profile_state VALUES ('preserved', '{\"ok\":true}', 1)");
    closeOpenClawAgentDatabaseByPath(original.path);
    expect(readSqliteDatabaseCleanClose(original.path)).toBe(true);
    const lease =
      change === "foreign lease"
        ? claimOpenClawAgentDatabaseLease({ ...options, path: original.path })
        : undefined;
    try {
      if (lease) {
        openOpenClawStateDatabase({ env })
          .db.prepare(
            "UPDATE agent_database_leases SET owner_pid = ?, owner_start_time = NULL WHERE lease_id = ?",
          )
          .run(process.ppid, lease);
      } else {
        fs.writeFileSync(`${original.path}.seal`, "torn next-startup seal");
      }
      const gate = schema.agentDatabaseIntegrityBeforeMutationSteps;
      let diagnostics: SqliteIntegrityDiagnostics | undefined;
      vi.spyOn(schema, "agentDatabaseIntegrityBeforeMutationSteps").mockImplementation(function* (
        ...args
      ) {
        const result = yield* gate(...args);
        diagnostics = args[3];
        return result;
      });
      const queued = vi
        .spyOn(verifier, "requestOpenClawAgentDatabaseIntegrityCheck")
        .mockImplementation(() => {});
      logger.info.mockClear();
      const reopened = openOpenClawAgentDatabase(options);
      expect(
        reopened.db
          .prepare("SELECT state_json FROM auth_profile_state WHERE state_key='preserved'")
          .get(),
      ).toEqual({ state_json: '{"ok":true}' });
      expect(diagnostics?.integrityGateOutcome).toBe("cached");
      expect(logger.info).not.toHaveBeenCalled();
      expect(queued).not.toHaveBeenCalled();
      reopened.db.exec("UPDATE auth_profile_state SET updated_at=2 WHERE state_key='preserved'");
      expect(readSqliteDatabaseCleanClose(original.path)).toBe(false);
    } finally {
      if (lease) releaseOpenClawAgentDatabaseLease(lease, { env }, "read-only");
    }
  },
);

it("adopts the released quarantine schema without changing its rows or version", () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-integrity-upgrade-") };
  const storePath = resolveQuarantineStorePath(env);
  const quarantinedPath = path.join(env.OPENCLAW_STATE_DIR, "retained.sqlite");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const previous = sqlite.openNodeSqliteDatabase(storePath);
  try {
    // The quarantine schema shipped in v2026.9.5 has no integrity-receipt table.
    previous.exec(`
      CREATE TABLE quarantined_databases (
        path TEXT NOT NULL PRIMARY KEY,
        kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        quarantined_at INTEGER NOT NULL,
        writer_app_version TEXT,
        verified_generation TEXT
      ) STRICT;
      PRAGMA user_version = 2;
    `);
    previous
      .prepare("INSERT INTO quarantined_databases VALUES (?, ?, ?, ?, ?, ?)")
      .run(quarantinedPath, "agent", "retained quarantine", 1, "2026.9.5", null);
  } finally {
    previous.close();
  }

  const database = openOpenClawAgentDatabase({ agentId: "upgraded", env });
  expect(readSqliteDatabaseCleanClose(database.path)).toBe(false);
  const upgraded = sqlite.openNodeSqliteDatabase(storePath, { readOnly: true });
  try {
    expect(upgraded.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(upgraded.prepare("SELECT * FROM quarantined_databases").all()).toEqual([
      {
        path: quarantinedPath,
        kind: "agent",
        reason: "retained quarantine",
        quarantined_at: 1,
        writer_app_version: "2026.9.5",
        verified_generation: null,
      },
    ]);
  } finally {
    upgraded.close();
  }
});

it("refuses the first write when its clean-close seal cannot be removed", () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-integrity-dirty-failure-") };
  const options = { agentId: "policy", env };
  const agent = openOpenClawAgentDatabase(options);
  closeOpenClawAgentDatabaseByPath(agent.path);
  expect(readSqliteDatabaseCleanClose(agent.path)).toBe(true);
  const unlink = fs.unlinkSync;
  const failure = Object.assign(new Error("synthetic seal unlink failed"), { code: "EACCES" });
  const intercepted = vi.spyOn(fs, "unlinkSync").mockImplementation((pathname) => {
    if (String(pathname) === `${agent.path}.seal`) throw failure;
    return unlink(pathname);
  });
  try {
    expect(() => {
      const reopened = openOpenClawAgentDatabase(options);
      reopened.db.exec("INSERT INTO auth_profile_state VALUES ('must-not-write', '{}', 1)");
    }).toThrow(failure);
  } finally {
    intercepted.mockRestore();
  }
  const reopened = openOpenClawAgentDatabase(options);
  expect(
    reopened.db
      .prepare("SELECT state_key FROM auth_profile_state WHERE state_key='must-not-write'")
      .get(),
  ).toBeUndefined();
  reopened.db.exec("INSERT INTO auth_profile_state VALUES ('can-write', '{}', 1)");
  expect(readSqliteDatabaseCleanClose(agent.path)).toBe(false);
});
