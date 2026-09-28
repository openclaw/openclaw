import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { discoverAgentDatabaseMigrationTargets } from "../infra/state-migrations.media-persistence-targets.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
  type OpenClawAgentDatabaseWorkerLeaseReceipt,
} from "./openclaw-agent-db-lease.js";
import { openOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  listOpenClawRegisteredAgentDatabases,
  unregisterOpenClawAgentDatabase,
} from "./openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  ensureOpenClawAgentDatabaseSchema,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import { cleanupRetiredAgentDatabaseLease } from "./openclaw-agent-execution-cleanup.js";
import { readOpenClawAgentIntegrityVerification } from "./openclaw-quarantine-store.js";
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
    record: () => readOpenClawAgentIntegrityVerification(database.path, env),
  };
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
      openOpenClawAgentDatabase({
        agentId: "integrity-lease",
        env: owner.env,
        path: owner.database.path,
      });
    }
    const child = await openChild(childPath, owner.env);
    expect(owner.record()?.clean_close).toBe(0);

    closeOpenClawAgentDatabaseByPath(owner.database.path);
    expect(owner.record()?.clean_close).toBe(0);

    const exited = once(child, "exit");
    child.send("close");
    expect(await exited).toEqual([0, null]);
    expect(readOpenClawAgentIntegrityVerification(childPath, owner.env)?.clean_close).toBe(1);
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
      expect(owner.record()).toBeUndefined();
      closeOpenClawAgentDatabaseByPath(owner.database.path);
      expect(owner.record()).toBeUndefined();
    } else {
      closeOpenClawAgentDatabaseByPath(owner.database.path);
      expect(owner.record()?.clean_close).toBe(0);
    }
    openOpenClawAgentDatabase({ agentId: "integrity-lease", env: owner.env });
    expect(owner.record()?.clean_close).toBe(0);
    expect(
      state.db
        .prepare("SELECT lease_id FROM agent_database_leases WHERE owner_pid = ?")
        .all(child.pid!),
    ).toEqual([]);
    closeOpenClawAgentDatabaseByPath(owner.database.path);
    expect(owner.record()?.clean_close).toBe(1);
  },
);

it("does not certify a failed checkpoint or native close", () => {
  const owner = openOwner();
  vi.spyOn(owner.database.walMaintenance, "close").mockReturnValueOnce(false);
  closeOpenClawAgentDatabaseByPath(owner.database.path);
  expect(owner.record()).toBeUndefined();

  closeOpenClawAgentDatabasesForTest();
  const reopened = openOpenClawAgentDatabase({ agentId: "integrity-lease", env: owner.env });
  const failure = new Error("synthetic native close failed");
  vi.spyOn(reopened.db, "close").mockImplementationOnce(() => {
    throw failure;
  });
  expect(() => closeOpenClawAgentDatabaseByPath(reopened.path)).toThrow(failure);
  expect(owner.record()).toBeUndefined();
  closeOpenClawAgentDatabaseByPath(reopened.path);
  expect(owner.record()).toBeUndefined();
});

it("does not certify a last read-only release without a writer checkpoint", () => {
  const owner = openOwner();
  const options = { agentId: "integrity-lease", env: owner.env, path: owner.database.path };
  const lease = claimOpenClawAgentDatabaseLease(options);
  const reader = openOpenClawAgentDatabaseReadOnly(options);
  expect(reader.found).toBe(true);
  if (!reader.found) {
    throw new Error("Expected the existing real agent database");
  }
  try {
    closeOpenClawAgentDatabaseByPath(owner.database.path);
    expect(owner.record()?.clean_close).toBe(0);
  } finally {
    reader.database.close();
    releaseOpenClawAgentDatabaseLease(lease, { env: owner.env }, "read-only");
  }
  expect(owner.record()?.clean_close).toBe(0);
});

it("records a full check while another lease belongs to the same process", () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-peer-") };
  const options = { agentId: "integrity-lease", env };
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const lease = claimOpenClawAgentDatabaseLease({ ...options, path: pathname });
  try {
    const database = openOpenClawAgentDatabase(options);
    expect(readOpenClawAgentIntegrityVerification(database.path, env)?.clean_close).toBe(0);
    closeOpenClawAgentDatabaseByPath(database.path);
    expect(readOpenClawAgentIntegrityVerification(database.path, env)?.clean_close).toBe(0);
  } finally {
    releaseOpenClawAgentDatabaseLease(lease, { env }, "read-only");
  }
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
      expect(
        reopened.db
          .prepare("SELECT name FROM sqlite_schema WHERE name='agent_deletion_journal'")
          .get(),
      ).toBeUndefined();
    }
    expect(() =>
      operation === "unregistering"
        ? unregisterOpenClawAgentDatabase({ agentId: "retained", path: pathname, env })
        : closeOpenClawAgentDatabaseByPath(pathname),
    ).not.toThrow();
    expect(database.db.isOpen).toBe(false);
    {
      using retained = openNodeSqliteDatabase(pathname, { readOnly: true });
      expect(
        retained
          .prepare("SELECT state_json FROM auth_profile_state WHERE state_key='preserved'")
          .get(),
      ).toEqual({ state_json: '{"ok":true}' });
    }
    {
      using reopened = openNodeSqliteDatabase(shared.path, { readOnly: true });
      expect(
        reopened
          .prepare("SELECT name FROM sqlite_schema WHERE name='agent_deletion_journal'")
          .get(),
      ).toBeUndefined();
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
    expect(
      reopened.db
        .prepare("SELECT state_json FROM auth_profile_state WHERE state_key='preserved'")
        .get(),
    ).toEqual({ state_json: '{"ok":true}' });
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
  expect(
    shared.prepare("SELECT name FROM sqlite_schema WHERE name='agent_deletion_journal'").get(),
  ).toBeUndefined();
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
      expect(
        reopened.db
          .prepare("SELECT name FROM sqlite_schema WHERE name='agent_deletion_journal'")
          .get(),
      ).toBeUndefined();
      closeOpenClawStateDatabase();
    }
  },
);
