import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import * as sqlite from "../infra/node-sqlite.js";
import {
  readSqliteCleanCloseSeal,
  writeSqliteCleanCloseSeal,
} from "../infra/sqlite-clean-close-seal.js";
import {
  readSqliteDatabaseCleanClose,
  retireSqliteDatabaseAdmissionForPath,
} from "../infra/sqlite-database-admission.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
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
import { sqliteDatabaseSealSchemaFor } from "./openclaw-database-seal-schema.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { resolveQuarantineStorePath } from "./openclaw-state-db.paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function optionsFor(agentId: string) {
  return { agentId, env: { OPENCLAW_STATE_DIR: tempDirs.make("agent-integrity-") } };
}

function observeSql(pathname?: string) {
  const statements: string[] = [];
  const open = sqlite.openNodeSqliteDatabase;
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    if (!pathname || args[0] === pathname) {
      const prepare = database.prepare.bind(database);
      vi.spyOn(database, "prepare").mockImplementation((sql) => {
        statements.push(sql);
        return prepare(sql);
      });
    }
    return database;
  });
  return statements;
}

it("certifies idle handles after grace and borrowed handles only after their final release", async () => {
  vi.useFakeTimers();
  const options = optionsFor("idle");
  const heldOptions = { ...options, agentId: "held" };
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

it.each([
  ["unchanged", 0],
  ["legacy-matching", 0],
  ["legacy-components-matching", 0],
  ["malformed-identity", 1],
  ["identity-mismatch", 1],
  ["runtime-change", 0],
  ["sqlite-change", 0],
  ["feature-mismatch", 1],
  ["schema-mismatch", 1],
  ["policy-mismatch", 1],
] as const)("validates the next admission's clean-close proof (%s)", (outcome, checks) => {
  const options = optionsFor("receipt-agent");
  const first = openOpenClawAgentDatabase(options);
  first.db.exec("INSERT INTO auth_profile_state VALUES ('preserved', '{}', 1)");
  closeOpenClawAgentDatabasesForTest();
  const file = fs.statSync(first.path, { bigint: true });
  const seal = readSqliteCleanCloseSeal(first.path, file)!;
  expect(seal).toBeDefined();
  // Drop process custody so admission must consume the on-disk restart proof.
  retireSqliteDatabaseAdmissionForPath(first.path);
  if (outcome !== "unchanged") {
    const identity = structuredClone(sqliteDatabaseSealSchemaFor("agent")!.identity);
    if (outcome === "runtime-change") {
      identity.runtime = '["other-runtime",null]';
    } else if (outcome === "sqlite-change") {
      identity.sqlite.version = "3.54.0";
      identity.sqlite.sourceId = "prior-source";
    } else if (outcome === "feature-mismatch") {
      identity.runtime = '["other-runtime",null]';
      identity.sqlite.compileOptions += ",OMIT_JSON";
    } else if (outcome === "schema-mismatch") {
      identity.runtime = '["other-runtime",null]';
      identity.schema = "other-schema";
    } else if (outcome === "policy-mismatch") {
      identity.runtime = '["other-runtime",null]';
      identity.policy -= 1;
    }
    expect(
      writeSqliteCleanCloseSeal(
        first.path,
        outcome.startsWith("legacy-") ? seal.schemaIdentity : "other-identity",
        file,
        {
          ...seal,
          identity:
            outcome === "legacy-matching" || outcome === "identity-mismatch"
              ? undefined
              : outcome === "legacy-components-matching"
                ? { ...identity, sqlite: "legacy-combined-hash" }
                : outcome === "malformed-identity"
                  ? { ...identity, sqlite: { version: "3.54.0" } }
                  : identity,
        },
      ),
    ).toBe(true);
  }
  const statements = observeSql(first.path);
  const reopened = openOpenClawAgentDatabase(options);
  expect(
    reopened.db
      .prepare("SELECT state_key FROM auth_profile_state WHERE state_key='preserved'")
      .get(),
  ).toEqual({
    state_key: "preserved",
  });
  expect(statements.filter((sql) => sql === "PRAGMA integrity_check;")).toHaveLength(checks);
  if (checks === 0) {
    expect(statements.filter((sql) => /PRAGMA (?:integrity|quick)_check/i.test(sql))).toEqual([]);
    expect(readSqliteDatabaseCleanClose(first.path)).toBe(true);
    closeOpenClawAgentDatabasesForTest();
    const reminted = readSqliteCleanCloseSeal(
      first.path,
      fs.statSync(first.path, { bigint: true }),
    )!;
    expect(reminted.verifiedAt).toBe(seal.verifiedAt);
    expect(reminted.identity).toEqual(sqliteDatabaseSealSchemaFor("agent")!.identity);
    retireSqliteDatabaseAdmissionForPath(first.path);
    statements.length = 0;
    openOpenClawAgentDatabase(options);
    expect(readSqliteDatabaseCleanClose(first.path)).toBe(true);
    expect(statements.filter((sql) => /PRAGMA (?:integrity|quick)_check/i.test(sql))).toEqual([]);
  }
});

it("retains admission through pinned WAL eviction and certifies the final checkpointed close", async () => {
  const options = optionsFor("main");
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const statements = observeSql(pathname);
  const worker = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
  const checks = () =>
    statements.filter((sql) => /^PRAGMA integrity_check(?:\('sqlite_schema'\))?;?$/.test(sql))
      .length + worker.mock.calls.length;
  const write = (updatedAt: number) =>
    runOpenClawAgentWriteTransaction(
      (database) =>
        writeSessionEntry(database, "agent:main:integrity", { sessionId: "retained", updatedAt }),
      options,
    );
  write(1);
  const reader = sqlite.openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    reader.exec("BEGIN");
    reader.prepare("SELECT updated_at FROM session_nodes").all();
    for (let iteration = 2; iteration <= 9; iteration += 1) {
      write(iteration);
      const database = openOpenClawAgentDatabase(options);
      closeCachedOpenClawAgentDatabase(database);
      expect(database.db.isOpen).toBe(false);
      await withOpenClawAgentDatabaseAsync(options, (reopened) => {
        expect(reopened.db.prepare("SELECT updated_at FROM session_nodes").get()).toEqual({
          updated_at: iteration,
        });
      });
    }
    expect(checks()).toBe(1);
  } finally {
    reader.close();
  }
  closeOpenClawAgentDatabasesForTest();
  expect(readSqliteDatabaseCleanClose(pathname)).toBe(true);
  openOpenClawAgentDatabase(options);
  expect(checks()).toBe(1);
});

it("refuses an orphan allocated page before admitting a dirty database", async () => {
  const expected = /never used/iu;
  const options = optionsFor("integrity-pages");
  const pathname = openOpenClawAgentDatabase(options).path;
  closeOpenClawAgentDatabasesForTest();
  invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(pathname);
  {
    using database = sqlite.openNodeSqliteDatabase(pathname);
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

it("rechecks the media version guard after a validated handle is replaced by a populated v0 store", () => {
  const options = optionsFor("worker-1");
  const databasePath = openOpenClawAgentDatabase(options).path;
  expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);

  fs.copyFileSync(databasePath, `${databasePath}.replacement`);
  fs.renameSync(`${databasePath}.replacement`, databasePath);
  {
    const { DatabaseSync } = sqlite.requireNodeSqlite();
    using downgraded = new DatabaseSync(databasePath);
    downgraded.exec(`
      PRAGMA user_version = 0;
      UPDATE schema_meta SET schema_version = 0 WHERE meta_key = 'primary';
    `);
  }

  expect(() => openOpenClawAgentDatabase(options)).toThrow(
    "run openclaw doctor --fix to migrate persisted media",
  );
});

it.each(["invalid seal", "foreign lease"] as const)(
  "retains admitted physical proof despite an %s",
  (change) => {
    const options = optionsFor("policy");
    const { env } = options;
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
      const statements = observeSql(original.path);
      const reopened = openOpenClawAgentDatabase(options);
      expect(
        reopened.db
          .prepare("SELECT state_json FROM auth_profile_state WHERE state_key='preserved'")
          .get(),
      ).toEqual({ state_json: '{"ok":true}' });
      expect(statements.filter((sql) => /PRAGMA (?:integrity|quick)_check/i.test(sql))).toEqual([]);
      reopened.db.exec("UPDATE auth_profile_state SET updated_at=2 WHERE state_key='preserved'");
      expect(readSqliteDatabaseCleanClose(original.path)).toBe(false);
    } finally {
      if (lease) {
        releaseOpenClawAgentDatabaseLease(lease, { env }, "read-only");
      }
    }
  },
);

it("preserves released v2 quarantine rows without requiring the retired receipt table", () => {
  const options = optionsFor("upgraded");
  const storePath = resolveQuarantineStorePath(options.env);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  {
    using previous = sqlite.openNodeSqliteDatabase(storePath);
    previous.exec(`
      CREATE TABLE quarantined_databases (
        path TEXT NOT NULL PRIMARY KEY, kind TEXT NOT NULL, reason TEXT NOT NULL,
        quarantined_at INTEGER NOT NULL, writer_app_version TEXT, verified_generation TEXT
      ) STRICT;
      PRAGMA user_version = 2;
      INSERT INTO quarantined_databases VALUES ('retained.sqlite', 'agent', 'retained quarantine', 1, '2026.9.5', NULL);
    `);
  }
  const database = openOpenClawAgentDatabase(options);
  expect(readSqliteDatabaseCleanClose(database.path)).toBe(false);
  using retained = sqlite.openNodeSqliteDatabase(storePath, { readOnly: true });
  expect(retained.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
  expect(retained.prepare("SELECT * FROM quarantined_databases").all()).toEqual([
    {
      path: "retained.sqlite",
      kind: "agent",
      reason: "retained quarantine",
      quarantined_at: 1,
      writer_app_version: "2026.9.5",
      verified_generation: null,
    },
  ]);
});

it("refuses the first write when its clean-close seal cannot be removed", () => {
  const options = optionsFor("policy");
  const agent = openOpenClawAgentDatabase(options);
  closeOpenClawAgentDatabaseByPath(agent.path);
  expect(readSqliteDatabaseCleanClose(agent.path)).toBe(true);
  const unlink = fs.unlinkSync;
  const failure = Object.assign(new Error("synthetic seal unlink failed"), { code: "EACCES" });
  const intercepted = vi.spyOn(fs, "unlinkSync").mockImplementation((pathname) => {
    if (String(pathname) === `${agent.path}.seal`) {
      throw failure;
    }
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
