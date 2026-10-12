import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  revokeSqliteDatabaseAdmissionsForPath,
  readSqliteDatabaseIntegrityVerification,
} from "../infra/sqlite-database-admission.js";
import { readStableSqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import { readMainDatabasePosixLocks } from "../infra/sqlite-posix-locks.test-support.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
import * as agentDatabase from "./openclaw-agent-db.js";
import {
  clearOpenClawAgentDatabaseOpenFailure,
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  recordOpenClawAgentDatabaseOpenFailure,
} from "./openclaw-agent-db.js";
import { databaseVerifyHostRuntimeEntrypoint } from "./openclaw-database-verify-runtime.test-support.js";
import {
  applyOpenClawDatabaseVerificationResults,
  runDatabaseVerifyWorker,
} from "./openclaw-database-verify.impl.js";
import {
  type OpenClawDatabaseVerifyResult,
  type OpenClawDatabaseVerifyTarget,
  verifyOpenClawDatabases,
} from "./openclaw-database-verify.worker.js";
import {
  clearOpenClawDatabaseQuarantine,
  readOpenClawDatabaseQuarantineFailure,
  recordOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.js";
import { readPersistedQuarantineRow } from "./openclaw-quarantine-store.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  recordOpenClawStateDatabaseOpenFailure,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { createUnsafeIndexDrift } from "./sqlite-index-drift.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    try {
      closeOpenClawAgentDatabasesForTest();
    } finally {
      try {
        closeOpenClawStateDatabaseForTest();
      } finally {
        cleanup();
      }
    }
  });
});

async function captureDatabaseVerifyWorkerSendFailure(failure: unknown): Promise<Error> {
  return await runDatabaseVerifyWorker([], {
    onWorker: (worker) => {
      if (!worker) {
        return;
      }
      worker.send = ((...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback === "function") {
          callback(failure);
        }
        return true;
      }) as ChildProcess["send"];
    },
  }).then(
    () => {
      throw new Error("expected database verification worker failure");
    },
    (rejection: unknown) => rejection as Error,
  );
}

describe("database verification error coercion", () => {
  it("preserves structured send failures across the database-worker boundary", async () => {
    const failure = { code: "SQLITE_IOERR", database: "state" };

    const error = await captureDatabaseVerifyWorkerSendFailure(failure);

    expect(error).toMatchObject({ message: "[object Object]", code: "SQLITE_IOERR" });
    expect(error.cause).toBe(failure);
  });
});

function repairUnsafeIndexDrift(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_index_records_value ON unsafe_index_records(indexed_value)' WHERE name = 'unsafe_index_records_value'",
      )
      .run();
    const schemaVersion = readSqliteNumberPragma(database, "schema_version");
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

async function copyHealthyDatabase(sourcePath: string, targetPath: string): Promise<void> {
  const sqlite = requireNodeSqlite();
  const source = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
  try {
    await sqlite.backup(source, targetPath);
  } finally {
    source.close();
  }
}

function quarantineStorePath(stateDir: string): string {
  return path.join(stateDir, "state", "openclaw-quarantine.sqlite");
}

function terminalVerificationResult(pathname: string): OpenClawDatabaseVerifyResult {
  return {
    path: pathname,
    ok: false,
    error: "prepared terminal integrity failure",
    terminal: true,
  };
}

function preparedVerificationResults(
  targets: readonly OpenClawDatabaseVerifyTarget[],
): OpenClawDatabaseVerifyResult[] {
  return targets.map((target) => terminalVerificationResult(target.path));
}

describe("OpenClaw database integrity verifier", () => {
  it("verifies an absent additive transcript eligibility projection without installing it", async () => {
    const stateDir = tempDirs.make("openclaw-database-verify-eligibility-");
    const agent = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    agent.db.exec(
      "DROP INDEX idx_agent_transcript_context_pending; ALTER TABLE session_transcript_active_events DROP COLUMN context_eligible;",
    );
    const targets: OpenClawDatabaseVerifyTarget[] = [
      { kind: "agent", label: "transcript eligibility", path: agent.path, check: "quick" },
    ];
    await expect(runDatabaseVerifyWorker(targets)).resolves.toEqual([
      { path: agent.path, ok: true },
    ]);
    expect(
      agent.db
        .prepare(
          "SELECT name FROM pragma_table_info('session_transcript_active_events') WHERE name = 'context_eligible'",
        )
        .get(),
    ).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "preserves live WAL ownership during an open database quick check",
    async () => {
      const stateDir = tempDirs.make("openclaw-database-verify-live-locks-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const agent = openOpenClawAgentDatabase({ agentId: "worker-1", env });
      agent.db
        .prepare(
          "INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES (?, ?, ?)",
        )
        .run("verifier-lock-owner", JSON.stringify({ preserved: true }), 1);
      const walBefore = fs.statSync(`${agent.path}-wal`);
      const shmBefore = fs.statSync(`${agent.path}-shm`);
      const baseLocksBefore =
        process.platform === "linux" ? readMainDatabasePosixLocks(agent.path) : [];
      if (process.platform === "linux") {
        expect(baseLocksBefore).toEqual([
          { length: 510, pid: process.pid, start: 1073741826, type: "read" },
        ]);
      }
      const targets: OpenClawDatabaseVerifyTarget[] = [
        {
          kind: "agent",
          label: "OpenClaw agent database worker-1",
          path: agent.path,
          check: "quick",
        },
      ];

      await expect(runDatabaseVerifyWorker(targets)).resolves.toEqual([
        expect.objectContaining({ path: agent.path, ok: true }),
      ]);
      if (process.platform === "linux") {
        // SQLite 3.51 can preserve visible WAL files after a lock is lost, so
        // assert the kernel lock itself rather than relying on that symptom.
        expect(readMainDatabasePosixLocks(agent.path)).toEqual(baseLocksBefore);
      }
      const reader = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            import { DatabaseSync } from "node:sqlite";
            const database = new DatabaseSync(process.env.OPENCLAW_VERIFY_TEST_PATH);
            database.prepare("PRAGMA schema_version;").get();
            database.close();
          `,
        ],
        {
          env: { ...process.env, OPENCLAW_VERIFY_TEST_PATH: agent.path },
          encoding: "utf8",
        },
      );

      expect(reader.stderr).toBe("");
      expect(reader.status).toBe(0);
      expect(fs.statSync(`${agent.path}-wal`).ino).toBe(walBefore.ino);
      expect(fs.statSync(`${agent.path}-shm`).ino).toBe(shmBefore.ino);
      expect(() =>
        agent.db
          .prepare("UPDATE auth_profile_state SET updated_at = ? WHERE state_key = ?")
          .run(2, "verifier-lock-owner"),
      ).not.toThrow();
    },
  );

  it("relays requested native Worker checks and revokes writes after verification failure", async () => {
    const result = await runNodeScript(
      (workerArgv) => workerArgv(resolveRuntimeWorkerUrl(databaseVerifyHostRuntimeEntrypoint)),
      process.env,
      30_000,
      { requireProcessTreeExit: true },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }, 35_000);

  it.each([
    { receipt: "present", check: "quick" },
    { receipt: "cleared", check: "full" },
  ] as const)(
    "leaves admission proof unchanged after a $check check when its receipt is $receipt",
    async ({ receipt, check }) => {
      const stateDir = tempDirs.make("openclaw-database-quick-receipt-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const agent = openOpenClawAgentDatabase({ agentId: "worker-1", env });
      const before = readSqliteDatabaseIntegrityVerification(agent.path);
      expect(before).toBeDefined();
      const targets: OpenClawDatabaseVerifyTarget[] = [
        { kind: "agent", label: "synthetic agent", path: agent.path, check },
      ];
      const results = await runDatabaseVerifyWorker(targets);
      expect(results).toMatchObject([{ path: agent.path, ok: true }]);
      if (receipt === "cleared") {
        revokeSqliteDatabaseAdmissionsForPath(agent.path);
      }
      const verifiedAt = (before?.verifiedAt ?? 0) + 100;
      const now = vi.spyOn(Date, "now").mockReturnValue(verifiedAt);
      try {
        await applyOpenClawDatabaseVerificationResults({ env, results, targets });
      } finally {
        now.mockRestore();
      }
      expect(readSqliteDatabaseIntegrityVerification(agent.path)).toEqual(
        receipt === "cleared" ? undefined : before,
      );
    },
  );

  it.each(["quick", "full"] as const)(
    "quarantines a %s-check foreign-key failure across close and reopen",
    async (check) => {
      const stateDir = tempDirs.make("openclaw-database-quick-verify-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const agent = openOpenClawAgentDatabase({ agentId: "worker-1", env });
      agent.db.exec(`
      CREATE TABLE quick_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE quick_child (parent_id INTEGER REFERENCES quick_parent(id));
      PRAGMA foreign_keys = OFF;
      INSERT INTO quick_child VALUES (123);
      PRAGMA foreign_keys = ON;
    `);
      const targets: OpenClawDatabaseVerifyTarget[] = [
        { kind: "agent", label: "synthetic agent", path: agent.path, check },
      ];

      const results = await runDatabaseVerifyWorker(targets);
      expect(results).toEqual([
        {
          path: agent.path,
          ok: false,
          error: expect.stringContaining("foreign_key_check failed"),
          terminal: true,
        },
      ]);
      const confirmationWorkers: Array<ChildProcess | undefined> = [];
      await applyOpenClawDatabaseVerificationResults({
        env,
        results,
        targets,
        workerLifetime: { onWorker: (worker) => confirmationWorkers.push(worker) },
      });
      expect(confirmationWorkers).toEqual([expect.any(Object), undefined]);
      expect(confirmationWorkers[0]?.exitCode).toBe(0);
      expect(agent.db.isOpen).toBe(false);
      expect(readPersistedQuarantineRow(agent.path, { env })?.reason).toContain(
        "foreign_key_check failed",
      );
      expect(readSqliteDatabaseIntegrityVerification(agent.path)).toBeUndefined();
      expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
        expect.objectContaining({ name: "SqliteIntegrityError" }),
      );
      if (process.platform !== "win32") {
        const alias = `${agent.path}.alias`;
        fs.symlinkSync(agent.path, alias);
        expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env, path: alias })).toThrow(
          expect.objectContaining({ name: "SqliteIntegrityError" }),
        );
      }

      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
        expect.objectContaining({
          name: "SqliteIntegrityError",
          message: expect.stringContaining("foreign_key_check failed"),
        }),
      );
      clearOpenClawAgentDatabaseOpenFailure(agent.path, { env });
      expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
        expect.objectContaining({ name: "SqliteIntegrityError" }),
      );
    },
  );

  it("quarantines full-check index damage before applying healthy proof", async () => {
    const stateDir = tempDirs.make("openclaw-database-full-verify-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const healthy = openOpenClawAgentDatabase({ agentId: "healthy", env });
    const agent = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    createUnsafeIndexDrift(agent.path);
    const healthyTarget = {
      kind: "agent",
      label: "synthetic healthy agent",
      path: healthy.path,
      check: "full",
    } as const;
    const target = { kind: "agent", label: "synthetic agent", path: agent.path } as const;
    const results = await runDatabaseVerifyWorker([
      healthyTarget,
      { ...target, check: "quick" },
      { ...target, check: "full" },
    ]);
    expect(results).toEqual([
      { path: healthy.path, ok: true },
      { path: agent.path, ok: true },
      {
        path: agent.path,
        ok: false,
        error: expect.stringMatching(/missing from index unsafe_index_records_value/iu),
        terminal: true,
      },
    ]);
    revokeSqliteDatabaseAdmissionsForPath(healthy.path);
    let quarantineAtPublication: ReturnType<typeof readOpenClawDatabaseQuarantineFailure>;
    let corruptOwnerOpenAtPublication: boolean | undefined;
    const onVerified = vi.fn(async () => {
      quarantineAtPublication = readOpenClawDatabaseQuarantineFailure("agent", agent.path, { env });
      corruptOwnerOpenAtPublication = agent.db.isOpen;
      throw new Error("Original healthy writer retired before proof publication");
    });
    await applyOpenClawDatabaseVerificationResults({
      env,
      results: [results[0]!, results[2]!],
      targets: [healthyTarget, { ...target, check: "full" }],
      onVerified,
    });
    expect(onVerified).toHaveBeenCalledExactlyOnceWith(healthy.path);
    expect(quarantineAtPublication).toMatchObject({
      name: "SqliteIntegrityError",
      message: expect.stringContaining("unsafe_index_records_value"),
    });
    expect(corruptOwnerOpenAtPublication).toBe(false);
    expect(readSqliteDatabaseIntegrityVerification(healthy.path)).toBeUndefined();
    expect(healthy.db.isOpen).toBe(true);
    expect(readPersistedQuarantineRow(healthy.path, { env })).toBeUndefined();
    expect(agent.db.isOpen).toBe(false);
    expect(readPersistedQuarantineRow(agent.path, { env })?.reason).toContain(
      "unsafe_index_records_value",
    );
    expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
      expect.objectContaining({ name: "SqliteIntegrityError" }),
    );
  });

  it("does not quarantine a healthy database that replaced the verified file", async () => {
    const stateDir = tempDirs.make("openclaw-database-verify-replacement-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const healthyReplacementPath = `${agentPath}.healthy`;
    const corruptArchivePath = `${agentPath}.corrupt`;
    fs.copyFileSync(agentPath, healthyReplacementPath);
    createUnsafeIndexDrift(agentPath);
    const targets: OpenClawDatabaseVerifyTarget[] = [
      { kind: "agent", label: "OpenClaw agent database worker-1", path: agentPath, check: "quick" },
    ];
    const results = preparedVerificationResults(targets);

    fs.renameSync(agentPath, corruptArchivePath);
    fs.renameSync(healthyReplacementPath, agentPath);
    await applyOpenClawDatabaseVerificationResults({ env, results, targets });

    expect(readPersistedQuarantineRow(agentPath, { env })).toBeUndefined();
    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "does not quarantine a healthy replacement while the corrupt agent inode is cached",
    async () => {
      const stateDir = tempDirs.make("openclaw-database-verify-live-agent-replace-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const agent = openOpenClawAgentDatabase({ agentId: "worker-1", env });
      const healthyReplacementPath = `${agent.path}.healthy`;
      const corruptArchivePath = `${agent.path}.corrupt`;
      await copyHealthyDatabase(agent.path, healthyReplacementPath);
      createUnsafeIndexDrift(agent.path);
      const targets: OpenClawDatabaseVerifyTarget[] = [
        {
          kind: "agent",
          label: "OpenClaw agent database worker-1",
          path: agent.path,
          check: "quick",
        },
      ];
      const results = preparedVerificationResults(targets);

      fs.renameSync(agent.path, corruptArchivePath);
      fs.renameSync(healthyReplacementPath, agent.path);
      await applyOpenClawDatabaseVerificationResults({ env, results, targets });

      expect(agent.db.isOpen).toBe(false);
      expect(readPersistedQuarantineRow(agent.path, { env })).toBeUndefined();
      expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not quarantine a healthy replacement while the corrupt state inode is cached",
    async () => {
      const stateDir = tempDirs.make("openclaw-database-verify-live-state-replace-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const state = openOpenClawStateDatabase({ env });
      const healthyReplacementPath = `${state.path}.healthy`;
      const corruptArchivePath = `${state.path}.corrupt`;
      await copyHealthyDatabase(state.path, healthyReplacementPath);
      createUnsafeIndexDrift(state.path);
      const targets: OpenClawDatabaseVerifyTarget[] = [
        { kind: "state", label: "OpenClaw state database", path: state.path, check: "quick" },
      ];
      const results = preparedVerificationResults(targets);

      fs.renameSync(state.path, corruptArchivePath);
      fs.renameSync(healthyReplacementPath, state.path);
      await applyOpenClawDatabaseVerificationResults({ env, results, targets });

      expect(state.db.isOpen).toBe(false);
      expect(readPersistedQuarantineRow(state.path, { env })).toBeUndefined();
      expect(openOpenClawStateDatabase({ env }).db.isOpen).toBe(true);
    },
  );

  it("drains actors admitted during confirmation before persisting quarantine", async () => {
    const stateDir = tempDirs.make("openclaw-database-verify-closed-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    createUnsafeIndexDrift(agentPath);
    const targets: OpenClawDatabaseVerifyTarget[] = [
      { kind: "agent", label: "OpenClaw agent database worker-1", path: agentPath, check: "quick" },
    ];
    const results = preparedVerificationResults(targets);

    const enteredClose = createDeferredCore();
    const releaseClose = createDeferredCore();
    const confirm = agentDatabase.confirmOpenClawAgentDatabaseIntegrity;
    const spy = vi
      .spyOn(agentDatabase, "confirmOpenClawAgentDatabaseIntegrity")
      .mockImplementationOnce(async (pathname) => {
        const confirmation = await confirm(pathname);
        registerOpenClawAgentDatabaseAsyncResource({
          agentId: "worker-1",
          path: pathname,
          revoke() {},
          close: async () => {
            enteredClose.resolve();
            await releaseClose.promise;
          },
        });
        return confirmation;
      });
    const verification = applyOpenClawDatabaseVerificationResults({ env, results, targets });
    try {
      expect(
        await Promise.race([
          enteredClose.promise.then(() => "closing"),
          verification.then(() => "completed"),
        ]),
      ).toBe("closing");
      expect(readPersistedQuarantineRow(agentPath, { env })).toBeUndefined();
    } finally {
      releaseClose.resolve();
      await verification;
      spy.mockRestore();
      await closeOpenClawAgentDatabaseByPathAsync(agentPath);
    }

    expect(readPersistedQuarantineRow(agentPath, { env })?.reason).toMatch(
      /missing from index unsafe_index_records_value/iu,
    );
    expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
      expect.objectContaining({ name: "SqliteIntegrityError" }),
    );
  });

  it("does not quarantine a repaired database after same-inode mutation", async () => {
    const stateDir = tempDirs.make("openclaw-database-verify-repair-race-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    createUnsafeIndexDrift(agentPath);
    const targets: OpenClawDatabaseVerifyTarget[] = [
      { kind: "agent", label: "OpenClaw agent database worker-1", path: agentPath, check: "quick" },
    ];
    const results = preparedVerificationResults(targets);

    repairUnsafeIndexDrift(agentPath);
    await expect(verifyOpenClawDatabases(targets)).resolves.toEqual([
      expect.objectContaining({ ok: true }),
    ]);
    await applyOpenClawDatabaseVerificationResults({ env, results, targets });

    expect(readPersistedQuarantineRow(agentPath, { env })).toBeUndefined();
    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("rejects stale terminal results after draining healthy owners", async () => {
    const stateDir = tempDirs.make("openclaw-database-verify-live-stale-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const state = openOpenClawStateDatabase({ env });
    const agent = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const targets: OpenClawDatabaseVerifyTarget[] = [
      { kind: "state", label: "OpenClaw state database", path: state.path, check: "quick" },
      {
        kind: "agent",
        label: "OpenClaw agent database worker-1",
        path: agent.path,
        check: "quick",
      },
    ];

    await applyOpenClawDatabaseVerificationResults({
      env,
      results: targets.map((target) => ({
        path: target.path,
        ok: false,
        error: "stale terminal result",
        terminal: true,
      })),
      targets,
    });

    expect(readPersistedQuarantineRow(state.path, { env })).toBeUndefined();
    expect(readPersistedQuarantineRow(agent.path, { env })).toBeUndefined();
    expect(state.db.isOpen).toBe(false);
    expect(agent.db.isOpen).toBe(false);
    expect(openOpenClawStateDatabase({ env }).db.isOpen).toBe(true);
    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("revalidates agent schema ownership after confirmation drains a pathname", async () => {
    const stateDir = tempDirs.make("openclaw-database-verify-agent-revalidate-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agent = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const replacementPath = `${agent.path}.replacement`;
    const { DatabaseSync } = requireNodeSqlite();
    const replacement = new DatabaseSync(replacementPath);
    replacement.close();
    expect(closeOpenClawAgentDatabaseByPath(agent.path)).toBe(true);
    fs.rmSync(agent.path);
    fs.renameSync(replacementPath, agent.path);
    const targets: OpenClawDatabaseVerifyTarget[] = [
      {
        kind: "agent",
        label: "OpenClaw agent database worker-1",
        path: agent.path,
        check: "quick",
      },
    ];

    await applyOpenClawDatabaseVerificationResults({
      env,
      results: [{ path: agent.path, ok: false, error: "stale terminal result", terminal: true }],
      targets,
    });

    const reopened = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(
      reopened.db
        .prepare("SELECT role, agent_id FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ role: "agent", agent_id: "worker-1" });
  });

  it("expires a generation-bound process latch after the database changes", () => {
    const stateDir = tempDirs.make("openclaw-database-verify-latch-generation-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    const generation = readStableSqliteFileGeneration(agentPath);
    const error = new Error("verified corrupt generation");
    error.name = "SqliteIntegrityError";

    expect(recordOpenClawAgentDatabaseOpenFailure(agentPath, error, generation)).toBe(true);
    const { DatabaseSync } = requireNodeSqlite();
    const changed = new DatabaseSync(agentPath);
    try {
      changed.exec("CREATE TABLE generation_change (id INTEGER PRIMARY KEY) STRICT;");
    } finally {
      changed.close();
    }

    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("reports an uncleared quarantine row instead of claiming repair success", () => {
    const stateDir = tempDirs.make("openclaw-database-verify-clear-failure-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    openOpenClawStateDatabase({ env });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    expect(
      recordOpenClawDatabaseQuarantine({
        env,
        kind: "agent",
        path: agentPath,
        reason: "corrupt index",
      }),
    ).toBe(true);
    const error = new Error("corrupt index");
    error.name = "SqliteIntegrityError";
    recordOpenClawAgentDatabaseOpenFailure(agentPath, error);
    closeOpenClawStateDatabaseForTest();

    const storePath = quarantineStorePath(stateDir);
    const before = readPersistedQuarantineRow(agentPath, { env });
    expect(before).toMatchObject({ kind: "agent", reason: "corrupt index" });
    const { DatabaseSync } = requireNodeSqlite();
    const quarantine = new DatabaseSync(storePath);
    try {
      // chmod cannot refuse writes from root; fail the real SQLite writes instead.
      quarantine.exec(`
        CREATE TRIGGER refuse_quarantine_clear BEFORE DELETE ON quarantined_databases
        BEGIN SELECT RAISE(ABORT, 'quarantine store is read-only'); END;
        CREATE TRIGGER refuse_quarantine_record BEFORE INSERT ON quarantined_databases
        BEGIN SELECT RAISE(ABORT, 'quarantine store is read-only'); END;
      `);
      expect(clearOpenClawAgentDatabaseOpenFailure(agentPath, { env })).toBe(false);
      expect(readPersistedQuarantineRow(agentPath, { env })).toEqual(before);
      expect(
        recordOpenClawDatabaseQuarantine({
          env,
          kind: "agent",
          path: agentPath,
          reason: "new reason",
        }),
      ).toBe(false);
      expect(readPersistedQuarantineRow(agentPath, { env })).toEqual(before);
      expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
        expect.objectContaining({
          name: "SqliteIntegrityError",
          message: expect.stringContaining("corrupt index"),
        }),
      );
      quarantine.exec(
        "DROP TRIGGER refuse_quarantine_clear; DROP TRIGGER refuse_quarantine_record;",
      );
    } finally {
      quarantine.close();
    }
    expect(clearOpenClawAgentDatabaseOpenFailure(agentPath, { env })).toBe(true);
    expect(readPersistedQuarantineRow(agentPath, { env })).toBeUndefined();
    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("retains the quarantine history marker without storing integrity receipts", () => {
    const stateDir = tempDirs.make("openclaw-database-verify-clean-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const state = openOpenClawStateDatabase({ env });
    expect(readPersistedQuarantineRow(state.path, { env })).toBeUndefined();
    expect(fs.existsSync(quarantineStorePath(stateDir))).toBe(false);

    const agent = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(readSqliteDatabaseIntegrityVerification(agent.path)).toMatchObject({
      verifiedAt: expect.any(Number),
    });
    expect(readPersistedQuarantineRow(agent.path, { env })).toBeUndefined();
    const { DatabaseSync } = requireNodeSqlite();
    using quarantine = new DatabaseSync(quarantineStorePath(stateDir), { readOnly: true });
    expect(quarantine.prepare("SELECT * FROM agent_integrity_verifications").all()).toEqual([]);
  });

  it("records and clears dedicated quarantine rows with rollback journaling", () => {
    const stateDir = tempDirs.make("openclaw-database-verify-store-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agent.sqlite");
    const storePath = quarantineStorePath(stateDir);

    expect(clearOpenClawDatabaseQuarantine(databasePath, { env })).toBe(true);
    expect(
      recordOpenClawDatabaseQuarantine({
        env,
        kind: "agent",
        path: databasePath,
        reason: "corrupt index",
      }),
    ).toBe(true);
    expect(readPersistedQuarantineRow(databasePath, { env })).toEqual({
      kind: "agent",
      quarantinedAt: expect.any(Number),
      reason: "corrupt index",
    });

    const { DatabaseSync } = requireNodeSqlite();
    const raw = new DatabaseSync(storePath, { readOnly: true });
    try {
      expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      expect(readSqliteNumberPragma(raw, "synchronous")).toBe(2);
      expect(readSqliteNumberPragma(raw, "user_version")).toBe(2);
    } finally {
      raw.close();
    }
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(storePath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);
    }
    expect(clearOpenClawDatabaseQuarantine(databasePath, { env })).toBe(true);
    expect(clearOpenClawDatabaseQuarantine(databasePath, { env })).toBe(true);
    expect(readPersistedQuarantineRow(databasePath, { env })).toBeUndefined();
  });

  it("expires a persisted quarantine when the verified database generation changes", () => {
    const stateDir = tempDirs.make("openclaw-database-verify-store-generation-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agent.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY) STRICT;");
    } finally {
      database.close();
    }
    const generation = readStableSqliteFileGeneration(databasePath);

    expect(
      recordOpenClawDatabaseQuarantine({
        env,
        generation,
        kind: "agent",
        path: databasePath,
        reason: "corrupt generation",
      }),
    ).toBe(true);
    const quarantineBefore = readPersistedQuarantineRow(databasePath, { env });
    expect(quarantineBefore?.reason).toBe("corrupt generation");
    expect(readOpenClawDatabaseQuarantineFailure("agent", databasePath, { env })).toMatchObject({
      name: "SqliteIntegrityError",
    });

    const changed = new DatabaseSync(databasePath);
    try {
      changed.exec("INSERT INTO records DEFAULT VALUES;");
    } finally {
      changed.close();
    }
    expect(readOpenClawDatabaseQuarantineFailure("agent", databasePath, { env })).toBeUndefined();
    expect(readPersistedQuarantineRow(databasePath, { env })).toEqual(quarantineBefore);
  });

  it("reads schema-v1 quarantine rows and migrates them on the next write", () => {
    const stateDir = tempDirs.make("openclaw-database-verify-store-v1-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agent.sqlite");
    const storePath = quarantineStorePath(stateDir);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(storePath);
    try {
      legacy.exec(`
        CREATE TABLE quarantined_databases (
          path TEXT NOT NULL PRIMARY KEY,
          kind TEXT NOT NULL,
          reason TEXT NOT NULL,
          quarantined_at INTEGER NOT NULL,
          writer_app_version TEXT
        ) STRICT;
        PRAGMA user_version = 1;
      `);
      legacy
        .prepare(
          "INSERT INTO quarantined_databases (path, kind, reason, quarantined_at) VALUES (?, ?, ?, ?)",
        )
        .run(path.resolve(databasePath), "agent", "legacy quarantine", 1);
    } finally {
      legacy.close();
    }

    expect(readPersistedQuarantineRow(databasePath, { env })).toEqual({
      kind: "agent",
      quarantinedAt: 1,
      reason: "legacy quarantine",
    });
    expect(readOpenClawDatabaseQuarantineFailure("agent", databasePath, { env })).toMatchObject({
      name: "SqliteIntegrityError",
    });
    expect(
      recordOpenClawDatabaseQuarantine({
        env,
        kind: "agent",
        path: databasePath,
        reason: "migrated quarantine",
      }),
    ).toBe(true);

    const migrated = new DatabaseSync(storePath, { readOnly: true });
    try {
      expect(readSqliteNumberPragma(migrated, "user_version")).toBe(2);
      expect(
        migrated
          .prepare("SELECT reason, verified_generation FROM quarantined_databases WHERE path = ?")
          .get(path.resolve(databasePath)),
      ).toEqual({ reason: "migrated quarantine", verified_generation: null });
    } finally {
      migrated.close();
    }
  });

  it("recovers an interrupted empty quarantine-store initialization", () => {
    const stateDir = tempDirs.make("openclaw-database-verify-empty-store-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agent.sqlite");
    const storePath = quarantineStorePath(stateDir);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, "", { mode: 0o600 });

    expect(readOpenClawDatabaseQuarantineFailure("agent", databasePath, { env })).toBeUndefined();
    expect(
      recordOpenClawDatabaseQuarantine({
        env,
        kind: "agent",
        path: databasePath,
        reason: "corrupt index",
      }),
    ).toBe(true);
    expect(readPersistedQuarantineRow(databasePath, { env })?.reason).toBe("corrupt index");
  });

  it.skipIf(process.platform === "win32")(
    "recovers a hot rollback journal before reading quarantine",
    () => {
      const stateDir = tempDirs.make("openclaw-database-verify-hot-journal-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const databasePath = path.join(stateDir, "agent.sqlite");
      const storePath = quarantineStorePath(stateDir);
      expect(
        recordOpenClawDatabaseQuarantine({
          env,
          kind: "agent",
          path: databasePath,
          reason: "committed reason",
        }),
      ).toBe(true);

      const quarantineBefore = readPersistedQuarantineRow(databasePath, { env });
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
        { env: { ...process.env, OPENCLAW_QUARANTINE_TEST_PATH: storePath } },
      );
      expect(crashed.signal).toBe("SIGKILL");
      expect(fs.existsSync(`${storePath}-journal`)).toBe(true);

      expect(readOpenClawDatabaseQuarantineFailure("agent", databasePath, { env })).toMatchObject({
        name: "SqliteIntegrityError",
      });
      expect(readPersistedQuarantineRow(databasePath, { env })).toEqual(quarantineBefore);
    },
  );

  it("does not latch transient verifier errors", async () => {
    const stateDir = tempDirs.make("openclaw-database-verify-transient-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const targets: OpenClawDatabaseVerifyTarget[] = [
      { kind: "agent", label: "OpenClaw agent database worker-1", path: agentPath, check: "quick" },
    ];

    await applyOpenClawDatabaseVerificationResults({
      env,
      results: [{ path: agentPath, ok: false, error: "Error: database is busy", terminal: false }],
      targets,
    });

    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("persists state failure quarantine across restart until doctor repair", () => {
    const stateDir = tempDirs.make("openclaw-database-verify-state-failure-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const statePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();

    expect(
      recordOpenClawDatabaseQuarantine({
        env,
        kind: "state",
        path: statePath,
        reason: "corrupt index",
      }),
    ).toBe(true);
    const error = new Error("corrupt index");
    error.name = "SqliteIntegrityError";
    recordOpenClawStateDatabaseOpenFailure(statePath, error);

    const { DatabaseSync } = requireNodeSqlite();
    const raw = new DatabaseSync(quarantineStorePath(stateDir), { readOnly: true });
    try {
      expect(
        raw.prepare("SELECT kind, reason FROM quarantined_databases WHERE path = ?").get(statePath),
      ).toEqual({ kind: "state", reason: "corrupt index" });
    } finally {
      raw.close();
    }
    expect(() => openOpenClawStateDatabase({ env })).toThrow(
      expect.objectContaining({
        name: "SqliteIntegrityError",
        message: expect.stringContaining("corrupt index"),
      }),
    );
    closeOpenClawStateDatabaseForTest();
    expect(() => openOpenClawStateDatabase({ env })).toThrow(
      expect.objectContaining({
        name: "SqliteIntegrityError",
        message: expect.stringContaining("corrupt index"),
      }),
    );
    expect(repairOpenClawStateDatabaseSchema({ env }).warnings).toEqual([]);
    expect(openOpenClawStateDatabase({ env }).db.isOpen).toBe(true);
  });
});
