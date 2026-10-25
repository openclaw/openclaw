import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  readSqliteCleanCloseSeal,
  writeSqliteCleanCloseSeal,
} from "../infra/sqlite-clean-close-seal.js";
import {
  readSqliteDatabaseCleanClose,
  retireSqliteDatabaseAdmissionForPath,
} from "../infra/sqlite-database-admission.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import { onSqliteWalCheckpoint } from "../infra/sqlite-wal-checkpoint.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
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
  type OpenClawAgentDatabaseWorkerLeaseReceipt,
} from "./openclaw-agent-db-lease.js";
import {
  closeCachedOpenClawAgentDatabase,
  recordOpenClawAgentDatabaseOpenFailure,
} from "./openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import { unregisterOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import {
  clearOpenClawAgentDatabaseOpenFailure,
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  ensureOpenClawAgentDatabaseSchema,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAdmission,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import { cleanupRetiredAgentDatabaseLease } from "./openclaw-agent-execution-cleanup.js";
import { sqliteDatabaseSealSchemaFor } from "./openclaw-database-seal-schema.js";
import {
  clearOpenClawDatabaseQuarantine,
  readOpenClawDatabaseQuarantineFailure,
} from "./openclaw-quarantine-store.js";
import { seedOpenClawDatabaseQuarantine } from "./openclaw-quarantine-store.test-support.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  resolveOpenClawStateSqlitePath,
  resolveQuarantineStorePath,
} from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const children = new Set<ChildProcess>();
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }),
  );
  children.clear();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

async function openChild(pathname: string, env: NodeJS.ProcessEnv, sharedPath?: string) {
  const script = sharedPath
    ? "./openclaw-agent-db-schema-contention.test-support.mjs"
    : "./openclaw-agent-db-held-child.test-support.ts";
  const child = fork(
    fileURLToPath(new URL(script, import.meta.url)),
    sharedPath ? [pathname, sharedPath] : ["integrity-lease", pathname],
    {
      execArgv: sharedPath ? [] : ["--import", "tsx"],
      env: { ...process.env, ...env },
      silent: true,
    },
  );
  children.add(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    const failed = () => reject(new Error(`Agent child exited before opening: ${stderr}`));
    child.once("error", reject);
    child.once("exit", failed);
    child.once("message", (message) => {
      child.off("exit", failed);
      if (message === "ready") {
        resolve();
      } else {
        reject(new Error(`Unexpected agent child message: ${JSON.stringify(message)}`));
      }
    });
  });
  return child;
}

function optionsFor(agentId: string) {
  return { agentId, env: { OPENCLAW_STATE_DIR: tempDirs.make("agent-integrity-") } };
}

function openOwner() {
  const options = optionsFor("integrity-lease");
  const { env } = options;
  const database = openOpenClawAgentDatabase(options);
  return {
    env,
    options,
    database,
    reopen: () => openOpenClawAgentDatabase(options),
    close: () => closeOpenClawAgentDatabaseByPath(database.path),
    cleanClose: () => readSqliteDatabaseCleanClose(database.path),
  };
}

function expectUnknownDeletionHistory(db: EngineConnection) {
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE name='agent_deletion_journal'").get(),
  ).toBeUndefined();
}

function expectPreservedRow(db: EngineConnection) {
  expect(
    db.prepare("SELECT state_json FROM auth_profile_state WHERE state_key='preserved'").get(),
  ).toEqual({
    state_json: '{"ok":true}',
  });
}

it("independent schema registration lets an agent writer commit shared state before admission", async () => {
  const owner = openOwner();
  const shared = openOpenClawStateDatabase({ env: owner.env });
  owner.close();
  using database = openNodeSqliteDatabase(owner.database.path);
  const child = await openChild(owner.database.path, owner.env, shared.path);
  const committed = once(child, "message");
  const exited = once(child, "exit");
  const execute = database.exec.bind(database);
  let signaled = false;
  vi.spyOn(database, "exec").mockImplementation((sql) => {
    if (!signaled && sql.trim() === "BEGIN IMMEDIATE") {
      signaled = true;
      child.send("commit");
    }
    return execute(sql);
  });

  ensureOpenClawAgentDatabaseSchema(database, {
    ...owner.options,
    path: owner.database.path,
    register: true,
  });

  const [outcome] = await committed;
  expect(outcome).toEqual({ status: "committed" });
  expect(await exited).toEqual([0, null]);
  expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(
    database
      .prepare("SELECT state_json FROM auth_profile_state WHERE state_key='schema-lock-order'")
      .get(),
  ).toEqual({ state_json: "{}" });
  expect(
    shared.db
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key='schema-lock-order'")
      .get(),
  ).toEqual({ value_json: "{}" });
});

it.each(process.platform === "win32" ? [false] : [false, true])(
  "publishes clean close only after the last process closes (alias: %s)",
  async (alias) => {
    const owner = openOwner();
    const childPath = alias ? `${owner.database.path}.alias` : owner.database.path;
    if (alias) {
      fs.symlinkSync(owner.database.path, childPath);
      owner.close();
      openOpenClawAgentDatabase({ ...owner.options, path: childPath });
      closeOpenClawAgentDatabaseByPath(childPath);
      const reopened = owner.reopen();
      reopened.db.exec("INSERT INTO auth_profile_state VALUES ('alias-writer', '{}', 1)");
    } else {
      // Let the child verify the file itself; a peer that borrows admission cannot certify it.
      owner.close();
    }
    const child = await openChild(childPath, owner.env);
    if (!alias) {
      owner.reopen().db.exec("INSERT INTO auth_profile_state VALUES ('parent-writer', '{}', 1)");
    }
    expect(owner.cleanClose()).toBe(false);

    owner.close();
    expect(owner.cleanClose()).toBe(false);

    const exited = once(child, "exit");
    child.send("close");
    expect(await exited).toEqual([0, null]);
    const canonicalPath = fs.realpathSync(childPath);
    expect(
      readSqliteCleanCloseSeal(canonicalPath, fs.statSync(canonicalPath, { bigint: true })),
    ).toMatchObject({ schemaIdentity: sqliteDatabaseSealSchemaFor("agent")?.schemaIdentity });
  },
);

it.each(["forced cleanup", "stale admission"])(
  "recovers a killed process via %s without certifying a surviving handle",
  async (recovery) => {
    const owner = openOwner();
    const child = await openChild(owner.database.path, owner.env);
    const state = openOpenClawStateDatabase({ env: owner.env });
    const row = state.db
      .prepare("SELECT * FROM agent_database_leases WHERE owner_pid = ?")
      .get(child.pid!) as {
      lease_id: string;
      agent_id: string;
      path: string;
      owner_pid: number;
      owner_start_time: number | null;
    };
    const receipt: OpenClawAgentDatabaseWorkerLeaseReceipt = {
      leaseId: row.lease_id,
      agentId: row.agent_id,
      path: row.path,
      ownerPid: row.owner_pid,
      ownerStartTime: row.owner_start_time,
      sharedStatePath: state.path,
      sharedStateIdentity: readDatabasePathIdentitySync(state.path).key,
    };
    const writing = once(child, "message");
    child.send("begin-write");
    expect(await writing).toEqual(["writing", undefined]);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    if (recovery === "forced cleanup") {
      await cleanupRetiredAgentDatabaseLease({
        context: captureOpenClawStateWorkerContext({ env: owner.env }),
        stopped: exited.then(() => {}),
        assertOwned() {
          expect(child.signalCode).toBe("SIGKILL");
        },
        lease: receipt,
      });
      expect(owner.cleanClose()).toBe(false);
    }
    owner.close();
    expect(owner.cleanClose()).toBe(false);
    const statements = observeSql(owner.database.path);
    const reopened = owner.reopen();
    expect(statements.filter((sql) => sql === "PRAGMA integrity_check;")).toHaveLength(1);
    expect(
      reopened.db
        .prepare("SELECT state_key FROM auth_profile_state WHERE state_key='killed-write'")
        .get(),
    ).toBeUndefined();
    expect(owner.cleanClose()).toBe(false);
    expect(
      state.db
        .prepare("SELECT lease_id FROM agent_database_leases WHERE owner_pid = ?")
        .all(child.pid!),
    ).toEqual([]);
    owner.close();
    expect(owner.cleanClose()).toBe(true);
  },
);

it("reuses a live peer process admission instead of rescanning the file", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-lease-peer-") };
  const pathname = resolveOpenClawAgentSqlitePath({ agentId: "integrity-lease", env });
  const child = await openChild(pathname, env);
  const statements = observeSql(pathname);

  const database = openOpenClawAgentDatabase({ agentId: "integrity-lease", env });

  expect(statements.filter((sql) => /PRAGMA (?:integrity|quick)_check/i.test(sql))).toEqual([]);
  database.db.exec("INSERT INTO auth_profile_state VALUES ('peer-borrow', '{}', 1)");
  const exited = once(child, "exit");
  child.send("close");
  expect(await exited).toEqual([0, null]);
  // The borrower never checked the file, so closing last leaves verification to the next opener.
  closeOpenClawAgentDatabaseByPath(database.path);
  expect(readSqliteDatabaseCleanClose(database.path)).toBe(false);
});

it("does not certify a failed checkpoint or native close", () => {
  const owner = openOwner();
  const checkpointFailure = new Error("synthetic checkpoint failed");
  const prepare = vi.spyOn(owner.database.db, "prepare").mockImplementationOnce(() => {
    throw checkpointFailure;
  });
  expect(owner.database.walMaintenance.checkpoint()).toBe(false);
  expect(owner.database.walMaintenance.health).toMatchObject({
    state: "error",
    error: checkpointFailure.message,
  });
  prepare.mockRestore();
  owner.close();
  expect(owner.cleanClose()).toBe(false);

  closeOpenClawAgentDatabasesForTest();
  const reopened = owner.reopen();
  const failure = new Error("synthetic native close failed");
  vi.spyOn(reopened.db, "close").mockImplementationOnce(() => {
    throw failure;
  });
  expect(() => closeOpenClawAgentDatabaseByPath(reopened.path)).toThrow(failure);
  expect(owner.cleanClose()).toBe(false);
  closeOpenClawAgentDatabaseByPath(reopened.path);
  expect(owner.cleanClose()).toBe(false);
});

it.each(["idle-peer", "settled", "pinned", "checkpoint-error"] as const)(
  "certifies only an empty WAL after the final native close (%s)",
  (outcome) => {
    const owner = openOwner();
    const database = owner.database;
    using reader = openNodeSqliteDatabase(database.path, { readOnly: true });
    if (outcome !== "idle-peer") {
      reader.exec("BEGIN");
    }
    reader.prepare("SELECT state_key FROM auth_profile_state").all();
    database.db.exec("INSERT INTO auth_profile_state VALUES ('shutdown-handoff', '{}', 1)");
    let incompleteCheckpoint = false;
    const stopObserving = onSqliteWalCheckpoint((checkpoint) => {
      if (
        checkpoint.databasePath === fs.realpathSync(database.path) &&
        checkpoint.health.state === "blocked"
      ) {
        incompleteCheckpoint = true;
        if (outcome === "settled") {
          reader.close();
        }
      }
    });
    if (outcome === "checkpoint-error") {
      reader.close();
      vi.spyOn(database.db, "prepare").mockImplementationOnce(() => {
        throw new Error("synthetic close checkpoint failed");
      });
    }
    try {
      owner.close();
    } finally {
      stopObserving();
    }
    if (outcome === "checkpoint-error") {
      expect(owner.cleanClose()).toBe(false);
    } else {
      expect(incompleteCheckpoint).toBe(outcome !== "idle-peer");
      const walBytes = fs.statSync(`${database.path}-wal`, { throwIfNoEntry: false })?.size ?? 0;
      if (outcome === "pinned") {
        expect(walBytes).toBeGreaterThan(0);
        expect(owner.cleanClose()).toBe(false);
      } else {
        expect(walBytes).toBe(0);
        expect(owner.cleanClose()).toBe(true);
        if (outcome === "idle-peer") {
          expect(reader.isOpen).toBe(true);
        }
      }
    }
  },
);

it.each(["before", "after"] as const)(
  "keeps verification dirty when a same-process read lease is claimed %s writer admission",
  (order) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-peer-") };
    const options = { agentId: "integrity-lease", env };
    const pathname = resolveOpenClawAgentSqlitePath(options);
    if (order === "after") {
      openOpenClawAgentDatabase(options);
    }
    const lease = claimOpenClawAgentDatabaseLease({ ...options, path: pathname });
    const database = openOpenClawAgentDatabase(options);
    const reader = order === "after" ? openOpenClawAgentDatabaseReadOnly(options) : undefined;
    try {
      if (reader) {
        expect(reader.found).toBe(true);
      }
      expect(readSqliteDatabaseCleanClose(database.path)).toBe(false);
      closeOpenClawAgentDatabaseByPath(database.path);
      expect(readSqliteDatabaseCleanClose(database.path)).toBe(false);
    } finally {
      if (reader?.found) {
        reader.database.close();
      }
      releaseOpenClawAgentDatabaseLease(lease, { env }, "read-only");
    }
    expect(readSqliteDatabaseCleanClose(database.path)).toBe(false);
  },
);

it("keeps proof dirty until the writer checkpoints after a healthy peer releases", () => {
  const owner = openOwner();
  const peerLease = claimOpenClawAgentDatabaseLease({
    ...owner.options,
    path: owner.database.path,
  });
  expect(owner.cleanClose()).toBe(false);
  releaseOpenClawAgentDatabaseLease(peerLease, { env: owner.env }, "uncheckpointed");
  expect(owner.cleanClose()).toBe(false);
  owner.close();
  expect(owner.cleanClose()).toBe(true);
});

it.each(["closing", "unregistering", "reopening shared state before closing"])(
  "does not recreate deletion history when %s an external store after shared state is lost",
  (operation) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-lease-lost-state-") };
    const pathname = path.join(tempDirs.make("agent-lease-external-"), "retained.sqlite");
    const database = openOpenClawAgentDatabase({ agentId: "retained", path: pathname, env });
    database.db.exec("INSERT INTO auth_profile_state VALUES ('preserved', '{\"ok\":true}', 1)");
    const shared = openOpenClawStateDatabase({ env });
    if (operation === "unregistering") {
      closeOpenClawAgentDatabaseByPath(pathname);
    }

    closeOpenClawStateDatabase();
    expect(shared.db.isOpen).toBe(false);
    for (const file of resolveSqliteDatabaseFilePaths(shared.path)) {
      fs.rmSync(file, { force: true });
    }

    if (operation === "reopening shared state before closing") {
      const reopened = openOpenClawStateDatabase({ env });
      expectUnknownDeletionHistory(reopened.db);
    }
    expect(() =>
      operation === "unregistering"
        ? unregisterOpenClawAgentDatabase({ agentId: "retained", path: pathname, env })
        : closeOpenClawAgentDatabaseByPath(pathname),
    ).not.toThrow();
    expect(database.db.isOpen).toBe(false);
    {
      using retained = openNodeSqliteDatabase(pathname, { readOnly: true });
      expectPreservedRow(retained);
    }
    {
      using reopened = openNodeSqliteDatabase(shared.path, { readOnly: true });
      expectUnknownDeletionHistory(reopened);
      expect(reopened.prepare("SELECT * FROM agent_database_leases").all()).toEqual([]);
    }
    const reopened = openOpenClawAgentDatabase({ agentId: "retained", path: pathname, env });
    expectPreservedRow(reopened.db);
  },
);

it("retains the selected sibling inventory when failed-open cleanup must recreate shared state", () => {
  const siblingDir = tempDirs.make("agent-cleanup-sibling-");
  const siblingPath = createLegacyDatabaseFixture({
    agentId: "sibling",
    path: path.join(siblingDir, "openclaw-agent.sqlite"),
    env: { OPENCLAW_STATE_DIR: tempDirs.make("agent-cleanup-seed-") },
    eventsBySession: {},
    schemaVersion: 19,
  });
  closeOpenClawStateDatabase();
  const env = {
    OPENCLAW_STATE_DIR: tempDirs.make("agent-cleanup-owner-"),
    OPENCLAW_CONFIG_PATH: path.join(tempDirs.make("agent-cleanup-config-"), "selected.json"),
    SIBLING_STORE: siblingDir,
  };
  fs.writeFileSync(
    env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({ agents: { entries: { sibling: { agentDir: "${SIBLING_STORE}" } } } }),
  );
  const pathname = path.join(tempDirs.make("agent-cleanup-new-"), "new.sqlite");
  const sharedPath = resolveOpenClawStateSqlitePath(env);
  const before = fs.readFileSync(siblingPath);
  const failure = new Error("synthetic agent open failed after shared state loss");
  const nativeOpen = nodeSqlite.openNodeSqliteDatabase;
  const open = vi
    .spyOn(nodeSqlite, "openNodeSqliteDatabase")
    .mockImplementation((file, options) => {
      if (file === pathname) {
        closeOpenClawStateDatabase();
        for (const part of resolveSqliteDatabaseFilePaths(sharedPath)) {
          fs.rmSync(part, { force: true });
        }
        throw failure;
      }
      return nativeOpen(file, options);
    });
  try {
    expect(() => openOpenClawAgentDatabase({ agentId: "new", path: pathname, env })).toThrow(
      failure,
    );
  } finally {
    open.mockRestore();
  }
  using shared = openNodeSqliteDatabase(sharedPath, { readOnly: true });
  expectUnknownDeletionHistory(shared);
  expect(shared.prepare("SELECT * FROM agent_database_leases").all()).toEqual([]);
  expect(fs.existsSync(pathname)).toBe(false);
  expect(fs.readFileSync(siblingPath)).toEqual(before);
});

it.each(["", "-wal", "-shm", "-journal"])(
  "preserves unknown deletion history from a surviving integrity-store family (%s)",
  (suffix) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-prior-integrity-state-") };
    const quarantinePath = resolveQuarantineStorePath(env);
    fs.mkdirSync(path.dirname(quarantinePath));
    // No live handles or receipt rows exist; the durable footprint alone proves prior admission.
    fs.writeFileSync(quarantinePath + suffix, "");
    for (let attempt = 0; attempt < 2; attempt++) {
      const reopened = openOpenClawStateDatabase({ env });
      expectUnknownDeletionHistory(reopened.db);
      closeOpenClawStateDatabase();
    }
  },
);

it.each(["quarantine", "schema-version latch"] as const)(
  "gates fresh read-only admission on %s and permits a repaired generation",
  (condition) => {
    const owner = openOwner();
    const options = owner.options;
    owner.close();
    closeOpenClawStateDatabase();
    if (condition === "quarantine") {
      // Drop process-held proof after persisting quarantine, as on restart.
      seedOpenClawDatabaseQuarantine({
        kind: "agent",
        path: owner.database.path,
        reason: "synthetic readonly quarantine",
        env: owner.env,
      });
    }
    closeOpenClawAgentDatabasesForTest();
    const latchError = new Error("synthetic schema-version latch");
    latchError.name = "SqliteSchemaVersionError";
    if (condition === "schema-version latch") {
      recordOpenClawAgentDatabaseOpenFailure(owner.database.path, latchError);
      expect(
        readOpenClawDatabaseQuarantineFailure("agent", owner.database.path, { env: owner.env }),
      ).toBeUndefined();
      expect(() => openOpenClawAgentDatabaseReadOnly(options)).toThrow(latchError);
      expect(clearOpenClawAgentDatabaseOpenFailure(owner.database.path, { env: owner.env })).toBe(
        true,
      );
    } else if (condition === "quarantine") {
      expect(
        readOpenClawDatabaseQuarantineFailure("agent", owner.database.path, { env: owner.env }),
      ).toBeDefined();

      expect(() => openOpenClawAgentDatabaseReadOnly(options)).toThrow(
        expect.objectContaining({ name: "SqliteIntegrityError" }),
      );

      // Clearing the quarantine (Doctor repair) makes the same generation readable again.
      expect(clearOpenClawDatabaseQuarantine(owner.database.path, { env: owner.env })).toBe(true);
    }
    const repaired = openOpenClawAgentDatabaseReadOnly(options);
    expect(repaired.found).toBe(true);
    if (repaired.found) {
      repaired.database.close();
    }
  },
);

function observeSql(pathname?: string) {
  const statements: string[] = [];
  const open = nodeSqlite.openNodeSqliteDatabase;
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
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
  const reader = nodeSqlite.openNodeSqliteDatabase(pathname, { readOnly: true });
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
    using database = nodeSqlite.openNodeSqliteDatabase(pathname);
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
    const { DatabaseSync } = nodeSqlite.requireNodeSqlite();
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
    using previous = nodeSqlite.openNodeSqliteDatabase(storePath);
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
  using retained = nodeSqlite.openNodeSqliteDatabase(storePath, { readOnly: true });
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
