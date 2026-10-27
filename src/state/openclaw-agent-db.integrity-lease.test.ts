import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { sqlPublicationAnchor, type EngineConnection } from "../infra/sql-connection.js";
import { readSqliteCleanCloseSeal } from "../infra/sqlite-clean-close-seal.js";
import { readSqliteDatabaseCleanClose } from "../infra/sqlite-database-admission.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import type { SqliteIntegrityDiagnostics } from "../infra/sqlite-integrity.js";
import { onSqliteWalCheckpoint } from "../infra/sqlite-wal-checkpoint.js";
import { configureSqliteConnectionPragmas } from "../infra/sqlite-wal.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { discoverAgentDatabaseMigrationTargets } from "../infra/state-migrations.media-persistence-targets.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
import { createAgentDatabaseHandleCloser } from "./openclaw-agent-db-close.js";
import { registerOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import * as provenance from "./openclaw-agent-db-lease-provenance.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
  type OpenClawAgentDatabaseWorkerLeaseReceipt,
} from "./openclaw-agent-db-lease.js";
import { recordOpenClawAgentDatabaseOpenFailure } from "./openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  listOpenClawRegisteredAgentDatabases,
  unregisterOpenClawAgentDatabase,
} from "./openclaw-agent-db-registry.js";
import * as schema from "./openclaw-agent-db-schema.js";
import {
  clearOpenClawAgentDatabaseOpenFailure,
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  ensureOpenClawAgentDatabaseSchema,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
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
import { createUnsafeIndexDrift } from "./sqlite-index-drift.test-support.js";

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

function openOwner() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-lease-") };
  const database = openOpenClawAgentDatabase({ agentId: "integrity-lease", env });
  return {
    env,
    database,
    cleanClose: () => readSqliteDatabaseCleanClose(database.path),
  };
}

async function closeChild(child: ChildProcess) {
  const exited = once(child, "exit");
  child.send("close");
  expect(await exited).toEqual([0, null]);
}

async function openUnsealedPeer(pathname: string, env: NodeJS.ProcessEnv) {
  // A claim needs an existing file, but a peer must not borrow its creator's seal.
  await closeChild(await openChild(pathname, env));
  fs.rmSync(`${pathname}.seal`);
  return openChild(pathname, env);
}

function observeIntegrity() {
  const gate = schema.agentDatabaseIntegrityBeforeMutationSteps;
  let diagnostics: SqliteIntegrityDiagnostics | undefined;
  vi.spyOn(schema, "agentDatabaseIntegrityBeforeMutationSteps").mockImplementation(function* (
    ...args
  ) {
    const result = yield* gate(...args);
    diagnostics = args[3];
    return result;
  });
  return () => diagnostics;
}

function expectUnknownDeletionHistory(db: EngineConnection) {
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE name='agent_deletion_journal'").get(),
  ).toBeUndefined();
}

function expectPreservedRow(db: EngineConnection) {
  expect(
    db.prepare("SELECT state_json FROM auth_profile_state WHERE state_key='preserved'").get(),
  ).toEqual({ state_json: '{"ok":true}' });
}

it("independent schema registration lets an agent writer commit shared state before admission", async () => {
  const owner = openOwner();
  const shared = openOpenClawStateDatabase({ env: owner.env });
  closeOpenClawAgentDatabaseByPath(owner.database.path);
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
    agentId: "integrity-lease",
    path: owner.database.path,
    env: owner.env,
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
      closeOpenClawAgentDatabaseByPath(owner.database.path);
      openOpenClawAgentDatabase({ agentId: "integrity-lease", env: owner.env, path: childPath });
      closeOpenClawAgentDatabaseByPath(childPath);
      const reopened = openOpenClawAgentDatabase({
        agentId: "integrity-lease",
        env: owner.env,
        path: owner.database.path,
      });
      reopened.db.exec("INSERT INTO auth_profile_state VALUES ('alias-writer', '{}', 1)");
    } else {
      // Let the child verify the file itself; a peer that borrows admission cannot certify it.
      closeOpenClawAgentDatabaseByPath(owner.database.path);
    }
    const child = await openChild(childPath, owner.env);
    if (!alias) {
      openOpenClawAgentDatabase({ agentId: "integrity-lease", env: owner.env }).db.exec(
        "INSERT INTO auth_profile_state VALUES ('parent-writer', '{}', 1)",
      );
    }
    expect(owner.cleanClose()).toBe(false);

    closeOpenClawAgentDatabaseByPath(owner.database.path);
    expect(owner.cleanClose()).toBe(false);

    await closeChild(child);
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
      closeOpenClawAgentDatabaseByPath(owner.database.path);
      expect(owner.cleanClose()).toBe(false);
    } else {
      closeOpenClawAgentDatabaseByPath(owner.database.path);
      expect(owner.cleanClose()).toBe(false);
    }
    const diagnostics = observeIntegrity();
    const reopened = openOpenClawAgentDatabase({ agentId: "integrity-lease", env: owner.env });
    expect(diagnostics()?.integrityGateOutcome).toBe("healthy");
    if (recovery === "stale admission") {
      expect(diagnostics()?.integrityGateReason).toBe("stale-lease-full");
    }
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
    closeOpenClawAgentDatabaseByPath(owner.database.path);
    expect(owner.cleanClose()).toBe(true);
  },
);

// Lease provenance (boot, PID namespace, build, inode) is only available on Linux.
it.runIf(process.platform === "linux")(
  "reuses a live peer process admission instead of rescanning the file",
  async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-lease-peer-") };
    const pathname = resolveOpenClawAgentSqlitePath({ agentId: "integrity-lease", env });
    const child = await openUnsealedPeer(pathname, env);
    const diagnostics = observeIntegrity();

    const database = openOpenClawAgentDatabase({ agentId: "integrity-lease", env });

    expect(diagnostics()).toMatchObject({ integrityGateOutcome: "cached" });
    expect(diagnostics()?.integrityGateMode).toBeUndefined();
    database.db.exec("INSERT INTO auth_profile_state VALUES ('peer-borrow', '{}', 1)");
    await closeChild(child);
    // The borrower never checked the file, so closing last leaves verification to the next opener.
    closeOpenClawAgentDatabaseByPath(database.path);
    expect(readSqliteCleanCloseSeal(pathname, fs.statSync(pathname, { bigint: true }))).toBe(
      undefined,
    );
  },
);

it.each([
  { swapped: false, outcome: "cached" },
  { swapped: true, outcome: "healthy" },
] as const)(
  "borrows a live peer admission only for the file opened after the claim (swapped: $swapped)",
  async ({ swapped, outcome }) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-lease-race-") };
    const pathname = resolveOpenClawAgentSqlitePath({ agentId: "integrity-lease", env });
    const child = await openUnsealedPeer(pathname, env);
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE agent_database_leases SET provenance = ? WHERE owner_pid = ?")
      .run("process-v1:admitted", child.pid!);
    let opened = false;
    vi.spyOn(provenance, "readAgentDatabaseLeaseProvenance").mockImplementation(() =>
      swapped && opened ? "process-v1:replacement" : "process-v1:admitted",
    );
    const open = nodeSqlite.openNodeSqliteDatabase;
    vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      opened ||= args[0] === pathname;
      return open(...args);
    });
    const diagnostics = observeIntegrity();

    const database = openOpenClawAgentDatabase({ agentId: "integrity-lease", env });

    expect(opened).toBe(true);
    expect(diagnostics()?.integrityGateOutcome).toBe(outcome);
    database.db.exec("INSERT INTO auth_profile_state VALUES ('race-writer', '{}', 1)");
    await closeChild(child);
    closeOpenClawAgentDatabaseByPath(pathname);
    // Only a process that actually checked the file can certify it on its last close.
    expect(
      readSqliteCleanCloseSeal(pathname, fs.statSync(pathname, { bigint: true })) !== undefined,
    ).toBe(swapped);
  },
);

it("does not lend a live peer admission to a file replaced at the same path", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-lease-replaced-") };
  const options = { agentId: "integrity-lease", env };
  const pathname = openOpenClawAgentDatabase(options).path;
  closeOpenClawAgentDatabaseByPath(pathname);
  const replacement = `${pathname}.replacement`;
  fs.copyFileSync(pathname, replacement);
  createUnsafeIndexDrift(replacement);
  const child = await openChild(pathname, env);
  fs.renameSync(replacement, pathname);

  expect(() => openOpenClawAgentDatabase(options)).toThrow(
    /integrity_check failed.*missing from index unsafe_index_records_value/iu,
  );
  await closeChild(child);
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
  closeOpenClawAgentDatabaseByPath(owner.database.path);
  expect(owner.cleanClose()).toBe(false);

  closeOpenClawAgentDatabasesForTest();
  const reopened = openOpenClawAgentDatabase({ agentId: "integrity-lease", env: owner.env });
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
    closeOpenClawAgentDatabaseByPath(owner.database.path);
    const db = openNodeSqliteDatabase(owner.database.path);
    registerOpenClawAgentDatabaseIdentity(db);
    const database = {
      ...owner.database,
      db,
      walMaintenance: configureSqliteConnectionPragmas(db, {
        databasePath: owner.database.path,
        busyTimeoutMs: 5_000,
        autoCheckpointPages: 0,
      }),
    };
    const leaseId = claimOpenClawAgentDatabaseLease({
      agentId: database.agentId,
      path: database.path,
      env: owner.env,
    });
    const close = createAgentDatabaseHandleCloser({
      leases: new Map([[database.path, { leaseId, env: owner.env }]]),
      failures: new Map(),
      idleTimers: new WeakMap(),
    });
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
      vi.spyOn(db, "prepare").mockImplementationOnce(() => {
        throw new Error("synthetic close checkpoint failed");
      });
    }
    try {
      close(database);
    } finally {
      stopObserving();
      if (db.isOpen) {
        db.close();
      }
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

it("preserves dirty proof without quarantine SQL when a healthy peer closes before checkpoint", () => {
  const owner = openOwner();
  const peerLease = claimOpenClawAgentDatabaseLease({
    agentId: "integrity-lease",
    path: owner.database.path,
    env: owner.env,
  });
  expect(owner.cleanClose()).toBe(false);
  const shared = openOpenClawStateDatabase({ env: owner.env });
  const leaseSql = trackSqliteStatementExecutions(
    sqlPublicationAnchor(shared.db),
    ["lease"],
    (sql) =>
      /\b(?:from|into|update)\s+"?agent_database_leases"?(?=\s|\(|$)/i.test(sql) ? "lease" : null,
  );
  const quarantineSql: string[] = [];
  const observer = observeHostDataSql((sql, database) => {
    if (
      database?.location() === resolveQuarantineStorePath(owner.env) ||
      /\b(?:quarantined_databases|agent_integrity_verifications)\b/i.test(sql)
    ) {
      quarantineSql.push(sql);
    }
  });
  try {
    releaseOpenClawAgentDatabaseLease(peerLease, { env: owner.env }, "uncheckpointed");
    expect(quarantineSql).toEqual([]);
  } finally {
    leaseSql.restore();
    observer.restore();
  }
  expect(owner.cleanClose()).toBe(false);
  closeOpenClawAgentDatabaseByPath(owner.database.path);
  expect(owner.cleanClose()).toBe(true);
  expect(leaseSql.counts.lease).toBe(1);
});

it.each(["closing", "unregistering", "reopening shared state before closing"])(
  "does not recreate deletion history when %s an external store after shared state is lost",
  (operation) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-lease-lost-state-") };
    const pathname = path.join(tempDirs.make("agent-lease-external-"), "retained.sqlite");
    const database = openOpenClawAgentDatabase({ agentId: "retained", path: pathname, env });
    database.db.exec("INSERT INTO auth_profile_state VALUES ('preserved', '{\"ok\":true}', 1)");
    const shared = openOpenClawStateDatabase({ env });
    const registeredAgentDatabases = listOpenClawRegisteredAgentDatabases({ env });
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
    const discovery = discoverAgentDatabaseMigrationTargets({
      env,
      configuredAgentDatabaseTargets: [],
      registeredAgentDatabases,
    });
    expect(discovery.targets).toEqual([]);
    expect(discovery.unverifiedTargets).toEqual([
      expect.objectContaining({ agentId: "retained", path: pathname }),
    ]);
    expect(discovery.warnings.join("\n")).toContain(`Held agent retained database ${pathname}`);
    expect(discovery.warnings.join("\n")).toContain("openclaw doctor --fix");
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
    const options = { agentId: "integrity-lease", env: owner.env };
    closeOpenClawAgentDatabaseByPath(owner.database.path);
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
