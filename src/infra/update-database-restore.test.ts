import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
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
import { discoverUpdateStateSchemaInspectionInProcess } from "./update-candidate-state.js";
import { createUpdateDatabaseBackupInProcess } from "./update-database-backup.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";
import { restoreUpdateDatabaseBackup } from "./update-database-restore.js";
import { createUpdateRun, getUpdateRun, recordUpdateRunPhase } from "./update-run-ledger.js";

async function createRestoreFixture(
  state: OpenClawTestState,
  linked: boolean | "existing" = false,
) {
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
  const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
  for (const owner of [shared, agent]) {
    owner.db.exec(
      "CREATE TABLE restore_witness(value TEXT); INSERT INTO restore_witness VALUES ('baseline');",
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
    { layout: "state-only", prefix: "update-database-restore-", scenario: "minimal" },
    async (state) => run(await createRestoreFixture(state, linked)),
  );
}

async function unchangedFiles(fixture: RestoreFixture) {
  const before = await Promise.all(
    fixture.backup.databases.map(async ({ path: pathname }) => ({
      pathname,
      identity: await fs.stat(pathname),
      bytes: await fs.readFile(pathname),
    })),
  );
  return async () => {
    for (const { pathname, identity, bytes } of before) {
      expect((await fs.stat(pathname)).ino).toBe(identity.ino);
      expect(await fs.readFile(pathname)).toEqual(bytes);
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
  "retires cached and worker owners before restoring data (linked=%s)",
  async (linked) => {
    await withFixture(async (fixture) => {
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
      expect(getUpdateRun(fixture.run.runId, { env: fixture.state.env })?.phase).toBe("requested");
      const restoredShared = openOpenClawStateDatabase({ env: fixture.state.env });
      const restoredAgent = openOpenClawAgentDatabase({
        agentId: "main",
        path: fixture.agent.path,
        env: fixture.state.env,
      });
      for (const owner of [restoredShared, restoredAgent]) {
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

it("verifies every snapshot before moving either live database", async () => {
  await withFixture(async (fixture) => {
    await fixture.close();
    const assertUnchanged = await unchangedFiles(fixture);
    await fs.appendFile(fixture.backup.databases[1]!.snapshotPath, "corrupt");
    await expect(fixture.restore()).rejects.toThrow("Database snapshot changed");
    await assertUnchanged();
  });
});

it.each([false, true])(
  "restores settled WAL databases only while their captured generation is current (foreignWrite=%s)",
  async (foreignWrite) => {
    await withFixture(async (fixture) => {
      for (const owner of [fixture.shared, fixture.agent]) {
        expect(owner.db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      }
      await fixture.close();
      const paths = [
        ...fixture.backup.databases.map((entry) => entry.path),
        ...fixture.backup.missingPaths,
      ];
      const expectedGenerations = readUpdateDatabaseGenerations(paths);
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
      if (foreignWrite) {
        expect(displaced).toBeNull();
        await assertUnchanged();
      } else {
        expect(displaced).not.toBeNull();
      }
      for (const { path: pathname } of fixture.backup.databases) {
        const restored = new DatabaseSync(pathname, { readOnly: true });
        try {
          expect(restored.prepare("SELECT value FROM restore_witness").all()).toEqual([
            {
              value: foreignWrite
                ? pathname === fixture.agent.path
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
    const assertUnchanged = await unchangedFiles(fixture);
    const native = new DatabaseSync(fixture.agent.path, { readOnly: true });
    try {
      native.exec("BEGIN");
      native.prepare("SELECT value FROM restore_witness").all();
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

it("refuses replacement while a foreign process owns state maintenance", async () => {
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
    try {
      expect((await once(child, "message", { signal: AbortSignal.timeout(5_000) }))[0]).toEqual({
        ready: true,
      });
      await expect(fixture.restore()).rejects.toThrow("failed to acquire gateway state ownership");
      await assertUnchanged();
      const closed = once(child, "close", { signal: AbortSignal.timeout(5_000) });
      child.send({ release: true });
      expect(await closed).toEqual([0, null]);
    } finally {
      await stopChildProcess(child, 5_000);
    }
  });
});
