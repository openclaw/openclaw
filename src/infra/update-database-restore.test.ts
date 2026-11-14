import { spawn } from "node:child_process";
import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import {
  resolveDaemonRuntimePinStorePath,
  withDaemonRuntimePinStore,
} from "../daemon/runtime-pin-store.js";
import { recordBackupRunOutcome } from "../state/backup-run-records.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { stateNativeProcessEntrypoints } from "../state/native-process-runtime.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import {
  openClientCredentialCustody,
  runClientCredentialOperation,
  type ClientCredentialOperation,
} from "./client-credential-store.js";
import * as durability from "./directory-durability.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import * as sqliteCopy from "./sqlite-file-copy.js";
import {
  discoverUpdateStateSchemaInspectionInProcess,
  readUpdateDatabaseGenerationsIsolated,
} from "./update-candidate-state.js";
import { createUpdateDatabaseBackupInProcess } from "./update-database-backup.js";
import { restoreUpdateDatabaseBackup } from "./update-database-restore.js";
import { createRetainedUpdateRecovery } from "./update-retained-recovery.test-support.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "./update-run-ledger.js";
import { readPluginCohortRecoveryPairRows } from "./update-run-recovery-store.js";
import { finishUpdateRun } from "./update-run-write.js";

async function createRestoreFixture(
  state: OpenClawTestState,
  linked = false,
  captureClientAbsent = false,
  retainHistory = true,
) {
  expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
  expect(process.env.HOME).toBe(state.home);
  const shared = openOpenClawStateDatabase({ env: state.env });
  let agentDirectory = state.agentDir();
  const canonicalAgent = linked
    ? openOpenClawAgentDatabase({
        agentId: "main",
        path: path.join(agentDirectory, "openclaw-agent.sqlite"),
        env: state.env,
      })
    : undefined;
  if (linked) {
    await fs.mkdir(agentDirectory, { recursive: true });
    const alias = state.path("linked-agent");
    await fs.symlink(agentDirectory, alias, "junction");
    agentDirectory = alias;
  }
  const agent = openOpenClawAgentDatabase({
    agentId: "main",
    path: path.join(agentDirectory, "openclaw-agent.sqlite"),
    env: state.env,
  });
  const removedRun = createUpdateRun({ trigger: "cli" }, { env: state.env });
  finishUpdateRun(
    removedRun.runId,
    { status: "failed", reason: "earlier-failure" },
    { env: state.env },
  );
  const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
  for (const [index, owner] of [shared, agent].entries()) {
    owner.db.exec(
      `CREATE TABLE restore_witness(value TEXT); INSERT INTO restore_witness(rowid,value) VALUES (${index === 0 ? 71 : 8191},'baseline');`,
    );
  }
  if (captureClientAbsent) {
    // Model a driver's absent preimage even though current fresh bootstrap creates this family.
    await fs.unlink(resolveClientCredentialStorePath(state.env));
  }
  if (!retainHistory) {
    // A service can have no local run history when its controller uses another database.
    shared.db.exec("DROP TABLE update_runs");
  }
  const input = {
    backupRoot: state.path("retained-package"),
    stateDir: state.stateDir,
    stagingRoot: state.path("snapshot-scratch"),
    config: {},
    env: state.env,
  };
  await fs.mkdir(`${input.backupRoot}.databases`, { mode: 0o700 });
  await fs.mkdir(input.stagingRoot, { mode: 0o700 });
  const backup = await createUpdateDatabaseBackupInProcess({
    ...input,
    inspectionPlan: await discoverUpdateStateSchemaInspectionInProcess(input),
  });
  if (retainHistory) {
    recordUpdateRunPhase(run.runId, "staging", {}, { env: state.env });
  }
  for (const owner of [shared, agent]) {
    owner.db.exec(
      "UPDATE restore_witness SET value = 'candidate'; CREATE TABLE candidate_only(value TEXT);",
    );
  }
  return {
    state,
    shared,
    agent,
    canonicalAgent,
    run,
    removedRun,
    backup,
    restore: (assertCurrent: () => void = () => undefined) =>
      restoreUpdateDatabaseBackup({ backup, runId: run.runId, env: state.env, assertCurrent }),
    close: async () => {
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      await closeOpenClawStateDatabaseAsync();
    },
  };
}

type RestoreFixture = Awaited<ReturnType<typeof createRestoreFixture>>;

function withFixture(
  run: (fixture: RestoreFixture) => Promise<void>,
  linked = false,
  retainHistory = true,
) {
  return withOpenClawTestState(
    { layout: "split", prefix: "update-database-restore-", scenario: "minimal" },
    async (state) => run(await createRestoreFixture(state, linked, false, retainHistory)),
  );
}

it.each([true, false])(
  "preserves only the named plugin cohort pair (history=%s)",
  async (retainHistory) => {
    await withFixture(
      async (fixture) => {
        const options = { env: fixture.state.env };
        const runtime = {
          root: fixture.state.home,
          nodePath: process.execPath,
          version: "2026.10.9",
          buildId: "fixture",
        };
        // Synthetic retained storage, not a serving or restoration receipt.
        const reservation = createRetainedUpdateRecovery(
          { runId: fixture.run.runId, from: runtime, to: runtime },
          options,
        );
        const binding = { runId: reservation.runId, transactionId: reservation.transactionId };
        writeConfigMachineState(
          "update.pluginCohort." + binding.runId,
          {
            ...binding,
            revision: 0,
            disposition: "rollback",
            installKey: fixture.state.home,
            priorArtifacts: [],
            artifacts: [],
            publications: [],
            settledPublications: 0,
          },
          options,
        );
        writeConfigMachineState("fixture.unrelated-candidate-state", { retain: false }, options);
        const retainedRows = readPluginCohortRecoveryPairRows(fixture.shared.db, binding);
        await restoreUpdateDatabaseBackup({
          backup: fixture.backup,
          runId: fixture.run.runId,
          env: fixture.state.env,
          assertCurrent() {},
          pluginCohortRecovery: binding,
        });
        const restored = openOpenClawStateDatabase(options);
        expect(readPluginCohortRecoveryPairRows(restored.db, binding)).toEqual(retainedRows);
        expect(
          readConfigMachineState("fixture.unrelated-candidate-state", options),
        ).toBeUndefined();
      },
      false,
      retainHistory,
    );
  },
);

it("refuses restoration when its named live cohort pair is missing", async () => {
  await withFixture(async (fixture) => {
    await expect(
      restoreUpdateDatabaseBackup({
        backup: fixture.backup,
        runId: fixture.run.runId,
        env: fixture.state.env,
        assertCurrent() {},
        pluginCohortRecovery: {
          runId: fixture.run.runId,
          transactionId: "00000000-0000-4000-8000-000000000001",
        },
      }),
    ).rejects.toThrow("Database rollback lost its live plugin cohort recovery pair.");
    const current = openOpenClawStateDatabase({ env: fixture.state.env });
    expect(current.db.prepare("SELECT value FROM restore_witness").get()).toEqual({
      value: "candidate",
    });
    expect(getUpdateRun(fixture.run.runId, { env: fixture.state.env })?.status).toBe("running");
  });
});

it("captures and restores exact local daemon intent with its independent schema", async () => {
  await withOpenClawTestState(
    { layout: "split", prefix: "update-daemon-restore-", scenario: "minimal" },
    async (state) => {
      const raw = '{ "version": 999, "broken": ';
      const key = "daemon-runtime-pin:malformed-intent";
      withDaemonRuntimePinStore(state.env, true, (db) => {
        db.prepare("INSERT INTO daemon_runtime_pins VALUES (?, ?, ?)").run(key, raw, 123);
      });
      const fixture = await createRestoreFixture(state);
      try {
        const pathname = resolveDaemonRuntimePinStorePath(state.env);
        expect(fixture.backup.databaseOwners).not.toContainEqual(
          expect.objectContaining({ path: pathname }),
        );
        expect(fixture.backup.databases).toContainEqual(
          expect.objectContaining({ path: pathname, userVersion: 1 }),
        );
        withDaemonRuntimePinStore(state.env, true, (db) => {
          db.prepare("UPDATE daemon_runtime_pins SET value_json = ?, updated_at_ms = ?").run(
            '{"version":1}',
            456,
          );
        });
        await fixture.restore();
        withDaemonRuntimePinStore(state.env, false, (db) => {
          expect(db.prepare("SELECT * FROM daemon_runtime_pins").all()).toEqual([
            { state_key: key, value_json: raw, updated_at_ms: 123 },
          ]);
        });
      } finally {
        await fixture.close();
      }
    },
  );
});

it.each(["present", "absent"] as const)(
  "restores the %s local credential store after a failed candidate",
  async (initial) => {
    await withOpenClawTestState(
      { layout: "split", prefix: "update-client-restore-", scenario: "minimal" },
      async (state) => {
        const pathname = state.statePath("client", "credentials.sqlite");
        const writeToken = (token: string, candidateCreatesAbsent = false) => {
          const operation: ClientCredentialOperation = {
            kind: "socket.ensure",
            fallback: {
              socket_key: "current",
              socket_path: "/synthetic/native.sock",
              socket_token: token,
              updated_at_ms: 123,
            },
            requested: { token },
          };
          if (candidateCreatesAbsent) {
            // Candidate bytes need no fabricated receipt; rollback removes the new family.
            using owner = openClientCredentialCustody(state.env, {
              createIfMissing: true,
              migration: true,
            })!;
            owner.run(operation);
          } else {
            runClientCredentialOperation(state.env, operation);
          }
        };
        if (initial === "present") {
          writeToken("synthetic-before-update");
        }
        const fixture = await createRestoreFixture(state, false, initial === "absent");
        try {
          expect(fixture.backup.databaseOwners).not.toContainEqual(
            expect.objectContaining({ path: pathname }),
          );
          if (initial === "present") {
            expect(fixture.backup.databases).toContainEqual(
              expect.objectContaining({ path: pathname, userVersion: 1 }),
            );
          } else {
            expect(fixture.backup.missingPaths).toContain(pathname);
          }
          writeToken("synthetic-candidate-write", initial === "absent");
          await fixture.restore();
          if (initial === "present") {
            using restored = new DatabaseSync(pathname, { readOnly: true });
            expect(restored.prepare("SELECT * FROM native_exec_socket_credentials").all()).toEqual([
              {
                socket_key: "current",
                socket_path: "/synthetic/native.sock",
                socket_token: "synthetic-before-update",
                updated_at_ms: 123,
              },
            ]);
          } else {
            await expect(fs.stat(pathname)).rejects.toMatchObject({ code: "ENOENT" });
          }
        } finally {
          await fixture.close();
        }
      },
    );
  },
);

async function unchangedFiles(fixture: RestoreFixture) {
  expect(process.env.OPENCLAW_STATE_DIR).toBe(fixture.state.stateDir);
  const before = await Promise.all(
    fixture.backup.databases.flatMap(({ path: pathname }) =>
      ["", "-wal", "-shm", "-journal"].map(async (suffix) => {
        const file = `${pathname}${suffix}`;
        const identity = await fs.lstat(file).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
          return undefined;
        });
        return { file, identity, bytes: identity ? await fs.readFile(file) : undefined };
      }),
    ),
  );
  return async () => {
    for (const { file, identity, bytes } of before) {
      if (identity) {
        const current = await fs.lstat(file);
        expect([current.dev, current.ino, current.nlink]).toEqual([
          identity.dev,
          identity.ino,
          identity.nlink,
        ]);
        expect(await fs.readFile(file)).toEqual(bytes);
      } else {
        await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
    for (const { path: pathname } of fixture.backup.databases) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        await expect(
          fs.lstat(`${pathname}.migrated-${fixture.run.runId}${suffix}`),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    }
  };
}

it("restores aliased databases through timestamp drift without rewinding update history", async () => {
  await withFixture(async (fixture) => {
    const originalBackupEntries = (await fs.readdir(fixture.backup.directory)).toSorted();
    const originalSnapshots = await Promise.all(
      fixture.backup.databases.map(async ({ snapshotPath }) => ({
        snapshotPath,
        bytes: await fs.readFile(snapshotPath),
      })),
    );
    const options = { env: fixture.state.env };
    const lateDetail = "Candidate migration failed after the database snapshot.";
    recordUpdateRunStep(
      fixture.run.runId,
      {
        step: "database migration",
        status: "failed",
        detail: lateDetail,
        reason: "doctor-failed",
      },
      options,
    );
    const newerRun = createUpdateRun({ trigger: "cli" }, options);
    finishUpdateRun(newerRun.runId, { status: "failed", reason: "later-failure" }, options);
    const rawOrigin = '{ "futureReceipt": { "z": 2, "a": [1, true] } }\n';
    fixture.shared.db
      .prepare("UPDATE update_runs SET origin_json = ? WHERE run_id = ?")
      .run(rawOrigin, fixture.run.runId);
    fixture.shared.db
      .prepare("DELETE FROM update_runs WHERE run_id = ?")
      .run(fixture.removedRun.runId);
    const currentHistory = fixture.shared.db
      .prepare("SELECT rowid,* FROM update_runs ORDER BY run_id")
      .all();
    expect(currentHistory).toHaveLength(2);
    await recordBackupRunOutcome({
      env: fixture.state.env,
      archivePath: fixture.state.path("candidate-only-backup"),
      kind: "sqlite-snapshot",
      status: "ok",
    });
    expect(fixture.shared.db.isOpen).toBe(true);
    expect(fixture.agent.db.isOpen).toBe(true);
    let timestampChanged = false;
    const displaced = await fixture.restore(() => {
      if (
        !timestampChanged &&
        fsSync.existsSync(fixture.agent.path) &&
        fsSync.existsSync(`${fixture.agent.path}.migrated-${fixture.run.runId}`)
      ) {
        // Settle metadata after the final guard hashes the restored bytes.
        const stat = fsSync.statSync(fixture.agent.path);
        fsSync.utimesSync(fixture.agent.path, stat.atime, new Date(stat.mtimeMs + 1_000));
        timestampChanged = true;
      }
    });
    expect(timestampChanged).toBe(true);
    expect(fixture.shared.db.isOpen).toBe(false);
    expect(fixture.agent.db.isOpen).toBe(false);
    if (fixture.canonicalAgent) {
      expect(fixture.canonicalAgent.db.isOpen).toBe(false);
    }
    expect(displaced).toEqual(
      expect.arrayContaining(
        fixture.backup.databases.map(
          ({ path: pathname }) => `${pathname}.migrated-${fixture.run.runId}`,
        ),
      ),
    );
    expect((await fs.readdir(fixture.backup.directory)).toSorted()).toEqual(originalBackupEntries);
    for (const { snapshotPath, bytes } of originalSnapshots) {
      expect(await fs.readFile(snapshotPath)).toEqual(bytes);
    }
    const restoredShared = openOpenClawStateDatabase({ env: fixture.state.env });
    expect(
      restoredShared.db.prepare("SELECT rowid,* FROM update_runs ORDER BY run_id").all(),
    ).toEqual(currentHistory);
    expect(getUpdateRun(fixture.run.runId, options)).toMatchObject({
      phase: "staging",
      reason: "doctor-failed",
      steps: expect.arrayContaining([
        expect.objectContaining({ status: "failed", detail: lateDetail }),
      ]),
    });
    const restoredAgent = openOpenClawAgentDatabase({
      agentId: "main",
      path: fixture.agent.path,
      env: fixture.state.env,
    });
    for (const owner of [restoredShared, restoredAgent]) {
      expect(owner.db.prepare("SELECT rowid FROM restore_witness").get()).toEqual({
        rowid: owner === restoredShared ? 71 : 8191,
      });
      expect(owner.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(owner.db.prepare("SELECT value FROM restore_witness").all()).toEqual([
        { value: "baseline" },
      ]);
      expect(
        owner.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'candidate_only'").get(),
      ).toBeUndefined();
      using migrated = new DatabaseSync(`${owner.path}.migrated-${fixture.run.runId}`, {
        readOnly: true,
      });
      expect(migrated.prepare("SELECT value FROM restore_witness").all()).toEqual([
        { value: "candidate" },
      ]);
    }
    expect(restoredShared.db.prepare("SELECT archive_path FROM backup_runs").all()).toEqual([]);
    const restoredArchivePath = fixture.state.path("restored-owner-backup");
    await recordBackupRunOutcome({
      env: fixture.state.env,
      archivePath: restoredArchivePath,
      kind: "sqlite-snapshot",
      status: "ok",
    });
    expect(restoredShared.db.prepare("SELECT archive_path FROM backup_runs").all()).toEqual([
      { archive_path: restoredArchivePath },
    ]);
  }, true);
});

it.each([
  { failureAt: 1, cleanupFails: false },
  { failureAt: 2, cleanupFails: false },
  { failureAt: 1, cleanupFails: true },
])(
  "leaves every current family unchanged when output $failureAt cannot allocate (cleanup failure=$cleanupFails)",
  async ({ failureAt, cleanupFails }) => {
    await withFixture(async (fixture) => {
      // One completed row needs an overflow page in the history preserved by rollback.
      const db = fixture.shared.db;
      const pagesBefore = Number(db.prepare("PRAGMA page_count").get()!.page_count);
      const origin = JSON.stringify({ growth: "x".repeat(4 * 1024) });
      db.prepare("UPDATE update_runs SET origin_json=? WHERE run_id=?").run(
        origin,
        fixture.removedRun.runId,
      );
      expect(db.prepare("PRAGMA page_count").get()!.page_count).toBeGreaterThan(pagesBefore);
      await fixture.close();
      const assertUnchanged = await unchangedFiles(fixture);
      const snapshots = await Promise.all(
        fixture.backup.databases.map(async (entry) => ({
          path: entry.snapshotPath,
          bytes: await fs.readFile(entry.snapshotPath),
          identity: await fs.stat(entry.snapshotPath),
        })),
      );
      const directories = [
        ...new Set(fixture.backup.databases.map((entry) => path.dirname(entry.path))),
        fixture.backup.directory,
      ];
      const entries = await Promise.all(directories.map((directory) => fs.readdir(directory)));
      const copy = sqliteCopy.copySqliteFile;
      let attempted = 0;
      const failure = Object.assign(new Error("writable output allocation exhausted"), {
        code: "ENOSPC",
      });
      const cleanupFailure = Object.assign(new Error("prepared directory cleanup refused"), {
        code: "EACCES",
      });
      const rmdir = fs.rmdir;
      let retainedDirectory:
        | { path: string; identity: Awaited<ReturnType<typeof fs.lstat>> }
        | undefined;
      const cleanup = vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
        const directory = String(args[0]);
        if (cleanupFails && path.basename(directory).startsWith(".sqlite-publish-prepared-")) {
          retainedDirectory = { path: directory, identity: await fs.lstat(directory) };
          throw cleanupFailure;
        }
        return rmdir(...args);
      });
      const allocation = vi
        .spyOn(sqliteCopy, "copySqliteFile")
        .mockImplementation(async (...args) => {
          if (args[1].includes(`${path.sep}.sqlite-publish-`) && ++attempted === failureAt) {
            throw failure;
          }
          return copy(...args);
        });
      try {
        if (cleanupFails) {
          await expect(fixture.restore()).rejects.toMatchObject({
            cause: failure,
            errors: [failure, cleanupFailure],
          });
        } else {
          await expect(fixture.restore()).rejects.toBe(failure);
        }
      } finally {
        allocation.mockRestore();
        cleanup.mockRestore();
      }
      expect(attempted).toBe(failureAt);
      await assertUnchanged();
      for (const snapshot of snapshots) {
        expect((await fs.stat(snapshot.path)).ino).toBe(snapshot.identity.ino);
        expect(await fs.readFile(snapshot.path)).toEqual(snapshot.bytes);
      }
      if (cleanupFails) {
        expect(retainedDirectory).toBeDefined();
        const retained = retainedDirectory!;
        expect(directories).toContain(path.dirname(retained.path));
        const identity = await fs.lstat(retained.path);
        expect([identity.dev, identity.ino]).toEqual([
          retained.identity.dev,
          retained.identity.ino,
        ]);
        expect(await fs.readdir(retained.path)).toEqual([]);
        await fs.rmdir(retained.path);
      }
      expect(await Promise.all(directories.map((directory) => fs.readdir(directory)))).toEqual(
        entries,
      );
    });
  },
);

it.each(["a changed snapshot", "missing current update history"] as const)(
  "refuses %s before moving either live database",
  async (failure) => {
    await withFixture(async (fixture) => {
      const backupEntries = (await fs.readdir(fixture.backup.directory)).toSorted();
      if (failure === "missing current update history") {
        fixture.shared.db.exec("DROP TABLE update_runs");
      }
      await fixture.close();
      const assertUnchanged = await unchangedFiles(fixture);
      if (failure === "a changed snapshot") {
        const snapshotPath = fixture.backup.databases[1]!.snapshotPath;
        const corrupted = await fs.readFile(snapshotPath);
        const offset = corrupted.length - 1;
        corrupted.writeUInt8(corrupted.readUInt8(offset) ^ 1, offset);
        await fs.writeFile(snapshotPath, corrupted);
      }
      await expect(fixture.restore()).rejects.toThrow(
        failure === "a changed snapshot"
          ? "Database snapshot changed"
          : "missing table update_runs",
      );
      await assertUnchanged();
      expect((await fs.readdir(fixture.backup.directory)).toSorted()).toEqual(backupEntries);
    });
  },
);

it.each(["collision", "after-rename", "final-publication"] as const)(
  "retains prepared recovery bytes only after the first move takes effect (%s)",
  async (failure) => {
    await withFixture(async (fixture) => {
      await fixture.close();
      const backupEntries = (await fs.readdir(fixture.backup.directory)).toSorted();
      const sources = await Promise.all(
        fixture.backup.databases.map(async (entry) => ({
          path: entry.path,
          bytes: await fs.readFile(entry.path),
        })),
      );
      const publish = durability.publishFileExclusive;
      let attempted: { sourcePath: string; targetPath: string } | undefined;
      const publication = vi
        .spyOn(durability, "publishFileExclusive")
        .mockImplementation(async (params) => {
          const selected =
            failure === "final-publication"
              ? sources.some((source) => source.path === params.targetPath)
              : params.targetPath.includes(`.migrated-${fixture.run.runId}`);
          if (attempted || !selected) {
            return publish(params);
          }
          attempted = params;
          if (failure === "collision") {
            await fs.writeFile(params.targetPath, "foreign recovery file", { flag: "wx" });
          } else {
            __setFsSafeTestHooksForTest({
              afterPublishTargetCreated: (_method, targetPath) => {
                if (targetPath === params.targetPath) {
                  throw new Error("Publication target created before metadata failed");
                }
              },
            });
          }
          return await publish(params);
        });
      try {
        await expect(fixture.restore()).rejects.toThrow();
      } finally {
        __setFsSafeTestHooksForTest(undefined);
        publication.mockRestore();
      }
      expect(attempted).toBeDefined();
      for (const source of sources) {
        const moved =
          failure === "final-publication" ||
          (failure === "after-rename" && source.path === attempted!.sourcePath);
        const movedPath = `${source.path}.migrated-${fixture.run.runId}`;
        expect(await fs.readFile(moved ? movedPath : source.path)).toEqual(source.bytes);
        if (moved) {
          await expect(fs.stat(source.path)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      const retained = (await fs.readdir(fixture.backup.directory)).toSorted();
      if (failure === "collision") {
        expect(await fs.readFile(attempted!.targetPath, "utf8")).toBe("foreign recovery file");
        expect(retained).toEqual(backupEntries);
      } else {
        expect(retained).toHaveLength(backupEntries.length + 1);
        for (const source of sources) {
          const parent = path.dirname(source.path);
          const prepared = (await fs.readdir(parent)).filter((name) =>
            name.startsWith(".sqlite-publish-prepared-"),
          );
          expect(prepared).toHaveLength(1);
          const preparedPath = path.join(parent, prepared[0]!, "database.sqlite");
          using database = new DatabaseSync(preparedPath, {
            readOnly: true,
          });
          if (source.path === fixture.shared.path || source.path === fixture.agent.path) {
            expect(database.prepare("SELECT value FROM restore_witness").get()).toEqual({
              value: "baseline",
            });
          } else {
            const snapshot = fixture.backup.databases.find((entry) => entry.path === source.path)!;
            expect(await fs.readFile(preparedPath)).toEqual(
              await fs.readFile(snapshot.snapshotPath),
            );
          }
          expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
            integrity_check: "ok",
          });
        }
      }
    });
  },
);

it.each([
  "checkpoint",
  "checkpoint-foreign",
  "checkpoint-reverted",
  "checkpoint-identical",
] as const)(
  "restores WAL databases only while their captured generation is current (%s)",
  async (transition) => {
    await withFixture(async (fixture) => {
      const foreignWrite = transition.endsWith("foreign");
      const revertedWrite = transition.endsWith("reverted");
      for (const owner of [fixture.shared, fixture.agent]) {
        expect(owner.db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      }
      const paths = [
        ...fixture.backup.databases.map((entry) => entry.path),
        ...fixture.backup.missingPaths,
      ];
      await fixture.close();
      const agentPath = fixture.agent.path;
      const familyPaths = [agentPath, `${agentPath}-wal`, `${agentPath}-shm`];
      let expectedGenerations;
      let family: Buffer[];
      {
        using writer = new DatabaseSync(agentPath);
        writer.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE checkpoint_witness(value TEXT);");
        expectedGenerations = await readUpdateDatabaseGenerationsIsolated(paths, {
          env: fixture.state.env,
        });
        if (revertedWrite) {
          writer.exec(
            "UPDATE restore_witness SET value='foreign'; UPDATE restore_witness SET value='candidate';",
          );
        }
        family = await Promise.all(familyPaths.map((file) => fs.readFile(file)));
      }
      const committed = await fs.readFile(agentPath);
      // Retain the committed family after writer settlement, as a stopped
      // Gateway can leave it. Exclusive removal uses a private WAL index.
      for (const [index, file] of familyPaths.entries()) {
        await fs.writeFile(file, family[index]!);
      }
      expect(family[1]!.length).toBeGreaterThan(32);
      {
        using exclusion = new DatabaseSync(agentPath);
        exclusion.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; ROLLBACK;");
        if (transition === "checkpoint-identical") {
          // An exact reversal with unchanged retained write evidence leaves
          // no later data to lose. Admitting rollback is intentional.
          exclusion.exec(
            "UPDATE restore_witness SET value='foreign'; UPDATE restore_witness SET value='candidate';",
          );
        }
        expect(exclusion.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({
          busy: 0,
        });
      }
      expect(await fs.readFile(agentPath)).toEqual(committed);
      expect(await fs.readFile(`${agentPath}-shm`)).toEqual(family[2]);
      for (const { path: pathname } of fixture.backup.databases) {
        await expect(fs.lstat(`${pathname}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (foreignWrite) {
        using foreign = new DatabaseSync(fixture.agent.path);
        foreign.exec("UPDATE restore_witness SET value = 'foreign'");
      }
      const assertUnchanged = await unchangedFiles(fixture);
      const displaced = await restoreUpdateDatabaseBackup({
        backup: fixture.backup,
        runId: fixture.run.runId,
        env: fixture.state.env,
        assertCurrent: () => undefined,
        expectedGenerations,
      });
      if (foreignWrite || revertedWrite) {
        expect(displaced).toBeNull();
        expect(fixture.backup.restoreRefusal).toContain(fixture.agent.path);
        await assertUnchanged();
      } else {
        expect(displaced).not.toBeNull();
      }
      for (const pathname of [fixture.shared.path, fixture.agent.path]) {
        using restored = new DatabaseSync(pathname, { readOnly: true });
        expect(restored.prepare("SELECT value FROM restore_witness").all()).toEqual([
          {
            value:
              foreignWrite || revertedWrite
                ? foreignWrite && pathname === fixture.agent.path
                  ? "foreign"
                  : "candidate"
                : "baseline",
          },
        ]);
      }
      expect(runClientCredentialOperation(fixture.state.env, { kind: "socket.read" })).toEqual({
        kind: "socket",
        socket: null,
      });
    });
  },
);

it("rechecks authority after awaited snapshot verification before moving files", async () => {
  await withFixture(async (fixture) => {
    await fixture.close();
    const assertUnchanged = await unchangedFiles(fixture);
    const revoked = new Error("Update owner revoked during verification");
    let current = true;
    const hash = durability.sha256File;
    const verification = vi.spyOn(durability, "sha256File").mockImplementation(async (...args) => {
      const result = await hash(...args);
      current = false;
      return result;
    });
    try {
      await expect(
        fixture.restore(() => {
          if (!current) {
            throw revoked;
          }
        }),
      ).rejects.toBe(revoked);
      expect(current).toBe(false);
      await assertUnchanged();
    } finally {
      verification.mockRestore();
    }
  });
});

it("refuses replacement while a competing native SQLite reader owns exclusion", async () => {
  await withFixture(async (fixture) => {
    await fixture.close();
    using native = new DatabaseSync(fixture.agent.path, { readOnly: true });
    native.exec("BEGIN");
    native.prepare("SELECT value FROM restore_witness").all();
    const assertUnchanged = await unchangedFiles(fixture);
    await expect(fixture.restore()).rejects.toThrow("another SQLite connection is active");
    await assertUnchanged();
    expect(native.prepare("SELECT value FROM restore_witness").all()).toEqual([
      { value: "candidate" },
    ]);
  });
});

it("refuses replacement while a foreign process owns state maintenance", async ({ signal }) => {
  await withFixture(async (fixture) => {
    await fixture.close();
    const assertUnchanged = await unchangedFiles(fixture);
    const ownerUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.gatewayStateOwner);
    const child = spawn(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(ownerUrl).slice(0, -1),
        "--input-type=module",
        "--eval",
        `import { acquireGatewayStateOwner } from ${JSON.stringify(ownerUrl.href)};
       const owner = acquireGatewayStateOwner({ databasePath: process.argv[1] });
       process.send({ ready: true });
       process.on('message', () => { owner.release(); process.disconnect(); });`,
        fixture.shared.path,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const closed = once(child, "close");
    void closed.catch(() => undefined);
    try {
      expect(
        (
          await withinTest(
            awaitGateBeforeSettlement(
              once(child, "message"),
              closed,
              "Foreign state owner exited before readiness",
            ),
            signal,
          )
        )[0],
      ).toEqual({
        ready: true,
      });
      await expect(fixture.restore()).rejects.toThrow("failed to acquire gateway state ownership");
      await assertUnchanged();
      child.send({ release: true });
      expect(await withinTest(closed, signal)).toEqual([0, null]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    }
  });
});
