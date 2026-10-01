import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { recordBackupRunOutcome } from "../state/backup-run-records.js";
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
import * as durability from "./directory-durability.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import * as sqliteCopy from "./sqlite-file-copy.js";
import {
  discoverUpdateStateSchemaInspectionInProcess,
  readUpdateDatabaseGenerationsIsolated,
} from "./update-candidate-state.js";
import { createUpdateDatabaseBackupInProcess } from "./update-database-backup.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";
import { restoreUpdateDatabaseBackup } from "./update-database-restore.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "./update-run-ledger.js";
import { finishUpdateRun } from "./update-run-write.js";

async function createRestoreFixture(
  state: OpenClawTestState,
  linked: boolean | "existing" = false,
) {
  expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
  expect(process.env.HOME).toBe(state.home);
  const shared = openOpenClawStateDatabase({ env: state.env });
  let agentDirectory = state.agentDir();
  const canonicalAgent =
    linked === "existing"
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
  recordUpdateRunPhase(run.runId, "staging", {}, { env: state.env });
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
  linked: boolean | "existing" = false,
) {
  return withOpenClawTestState(
    { layout: "split", prefix: "update-database-restore-", scenario: "minimal" },
    async (state) => run(await createRestoreFixture(state, linked)),
  );
}

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

it.each([false, true, "existing"] as const)(
  "retires cached and worker owners without rewinding update history (linked=%s)",
  async (linked) => {
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
      const displaced = await fixture.restore();
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
      expect((await fs.readdir(fixture.backup.directory)).toSorted()).toEqual(
        originalBackupEntries,
      );
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
        const migrated = new DatabaseSync(`${owner.path}.migrated-${fixture.run.runId}`, {
          readOnly: true,
        });
        try {
          expect(migrated.prepare("SELECT value FROM restore_witness").all()).toEqual([
            { value: "candidate" },
          ]);
        } finally {
          migrated.close();
        }
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
    }, linked);
  },
);

it.each([
  { failureAt: 1, cleanupFails: false },
  { failureAt: 2, cleanupFails: false },
  { failureAt: 1, cleanupFails: true },
])(
  "leaves every current family unchanged when output $failureAt cannot allocate (cleanup failure=$cleanupFails)",
  async ({ failureAt, cleanupFails }) => {
    await withFixture(async (fixture) => {
      const options = { env: fixture.state.env };
      const origin = JSON.stringify({ growth: "x".repeat(8 * 1024) });
      for (let index = 0; index < 64; index++) {
        const historyRun = createUpdateRun({ trigger: "cli" }, options);
        finishUpdateRun(historyRun.runId, { status: "failed", reason: "history-growth" }, options);
        fixture.shared.db
          .prepare("UPDATE update_runs SET origin_json=? WHERE run_id=?")
          .run(origin, historyRun.runId);
      }
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
          const database = new DatabaseSync(path.join(parent, prepared[0]!, "database.sqlite"), {
            readOnly: true,
          });
          try {
            expect(database.prepare("SELECT value FROM restore_witness").get()).toEqual({
              value: "baseline",
            });
            expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
              integrity_check: "ok",
            });
          } finally {
            database.close();
          }
        }
      }
    });
  },
);

it.each([
  "settled",
  "checkpoint",
  "foreign",
  "checkpoint-foreign",
  "checkpoint-reverted",
  "checkpoint-identical",
] as const)(
  "restores WAL databases only while their captured generation is current (%s)",
  async (transition) => {
    await withFixture(async (fixture) => {
      const checkpoint = transition.startsWith("checkpoint");
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
      let expectedGenerations;
      if (checkpoint) {
        const pathname = fixture.agent.path;
        const familyPaths = [pathname, `${pathname}-wal`, `${pathname}-shm`];
        const writer = new DatabaseSync(pathname);
        let family: Buffer[];
        try {
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
        } finally {
          writer.close();
        }
        const committed = await fs.readFile(pathname);
        // Retain the committed family after writer settlement, as a stopped
        // Gateway can leave it. Exclusive removal uses a private WAL index.
        for (const [index, file] of familyPaths.entries()) {
          await fs.writeFile(file, family[index]!);
        }
        expect(family[1]!.length).toBeGreaterThan(32);
        const exclusion = new DatabaseSync(pathname);
        try {
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
        } finally {
          exclusion.close();
        }
        expect(await fs.readFile(pathname)).toEqual(committed);
        expect(await fs.readFile(`${pathname}-shm`)).toEqual(family[2]);
      } else {
        expectedGenerations = readUpdateDatabaseGenerations(paths);
      }
      for (const { path: pathname } of fixture.backup.databases) {
        await expect(fs.lstat(`${pathname}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (foreignWrite) {
        const foreign = new DatabaseSync(fixture.agent.path);
        try {
          foreign.exec("UPDATE restore_witness SET value = 'foreign'");
        } finally {
          foreign.close();
        }
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
      for (const { path: pathname } of fixture.backup.databases) {
        const restored = new DatabaseSync(pathname, { readOnly: true });
        try {
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
        } finally {
          restored.close();
        }
      }
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
    const native = new DatabaseSync(fixture.agent.path, { readOnly: true });
    try {
      native.exec("BEGIN");
      native.prepare("SELECT value FROM restore_witness").all();
      const assertUnchanged = await unchangedFiles(fixture);
      await expect(fixture.restore()).rejects.toThrow("another SQLite connection is active");
      await assertUnchanged();
      expect(native.prepare("SELECT value FROM restore_witness").all()).toEqual([
        { value: "candidate" },
      ]);
    } finally {
      native.close();
    }
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
