import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { automaticallyCleanUpdateRecovery } from "../cli/update-cli/automatic-cleanup.js";
import { prepareUpdateCommandTerminalResult } from "../cli/update-cli/update-command-terminal.js";
import { formatDiskSpaceBytes } from "../infra/disk-space.js";
import { readSessionSqliteMigrationManifest } from "../infra/session-sqlite-migration-manifest.js";
import { discoverUpdateStateSchemaInspectionInProcess } from "../infra/update-candidate-state.js";
import { createUpdateDatabaseBackupInProcess } from "../infra/update-database-backup.js";
import { restoreUpdateDatabaseBackup } from "../infra/update-database-restore.js";
import { createRetainedUpdateRecovery } from "../infra/update-retained-recovery.test-support.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunVerification,
} from "../infra/update-run-ledger.js";
import type { UpdateStepResult } from "../infra/update-step-result.js";
import { defaultRuntime } from "../runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { recordDoctorMigrationBackups } from "./doctor-migration-backup-artifacts.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const VERIFIED = {
  serviceRunning: true,
  versionMatch: true,
  settled: true,
  readyz: true,
  channelsReady: true,
  coreReady: true,
  pluginErrors: [],
};

function withState(run: (state: OpenClawTestState) => Promise<void>) {
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  return withOpenClawTestState(
    { layout: "split", prefix: "update-backup-cleanup-", scenario: "minimal" },
    async (state) => {
      try {
        await run(state);
      } finally {
        await closeOpenClawAgentDatabasesAsync(state.stateDir);
        await closeOpenClawStateDatabaseAsync();
      }
    },
  );
}

function agentPath(state: OpenClawTestState) {
  return path.join(state.agentDir(), "openclaw-agent.sqlite");
}

function openAgent(state: OpenClawTestState) {
  return openOpenClawAgentDatabase({ agentId: "main", path: agentPath(state), env: state.env });
}

function startRun(state: OpenClawTestState, at: number) {
  openAgent(state);
  using clock = vi.spyOn(Date, "now");
  clock.mockReturnValue(at);
  return createUpdateRun({ trigger: "cli" }, { env: state.env }).runId;
}

/** The Doctor of update `updateRunId` takes its pre-migration backup, as the producer does. */
async function doctorBackup(state: OpenClawTestState, database: string, updateRunId?: string) {
  await closeOpenClawAgentDatabasesAsync(state.stateDir);
  await closeOpenClawStateDatabaseAsync();
  const backupId = randomUUID();
  const backup = `${database}.pre-startup-migration-${backupId}.bak`;
  await withDoctorSqliteMaintenanceLock({
    env: state.env,
    operation: "fixture migration",
    run: () => {
      fs.copyFileSync(database, backup);
      recordDoctorMigrationBackups(
        updateRunId ? { ...state.env, OPENCLAW_UPDATE_RUN_ID: updateRunId } : state.env,
        backupId,
        [
          {
            path: database,
            identity: fs.statSync(database, { bigint: true }),
            archivePath: backup,
          },
        ],
      );
    },
  });
  return backup;
}

/** End a run through the CLI terminal path; it runs the automatic cleanup. */
async function finish(
  state: OpenClawTestState,
  runId: string,
  at: number,
  outcome: "verified" | "failed",
): Promise<UpdateStepResult | undefined> {
  if (outcome === "verified") {
    recordUpdateRunVerification(runId, VERIFIED, { env: state.env });
  }
  using clock = vi.spyOn(Date, "now");
  clock.mockReturnValue(at);
  const emit = await prepareUpdateCommandTerminalResult(
    { opts: { json: true, run: { runId, env: state.env } } },
    outcome === "verified"
      ? { status: "ok", mode: "git", steps: [], durationMs: 1 }
      : { status: "error", mode: "git", reason: "update-failed", steps: [], durationMs: 1 },
    { rolledBack: false },
  );
  const result = await emit();
  return result.steps.find((step) => step.name === "recovery-artifact-cleanup");
}

/**
 * Update R1 takes its database image and a Doctor backup, migrates, fails, and the
 * updater rolls the databases back: the live agent file becomes a new inode and the
 * migrated family moves to `<db>.migrated-<R1>`.
 */
async function rolledBackUpdate(state: OpenClawTestState, at: number) {
  const shared = openOpenClawStateDatabase({ env: state.env });
  const agent = openAgent(state);
  for (const owner of [shared, agent]) {
    owner.db.exec("CREATE TABLE witness(value TEXT); INSERT INTO witness VALUES ('baseline');");
  }
  const runId = startRun(state, at);
  const input = {
    backupRoot: state.path("retained-package"),
    stateDir: state.stateDir,
    stagingRoot: state.path("snapshot-scratch"),
    config: {},
    env: state.env,
  };
  fs.mkdirSync(`${input.backupRoot}.databases`, { mode: 0o700 });
  fs.mkdirSync(input.stagingRoot, { mode: 0o700 });
  const backup = await createUpdateDatabaseBackupInProcess({
    ...input,
    inspectionPlan: await discoverUpdateStateSchemaInspectionInProcess(input),
  });
  recordUpdateRunPhase(runId, "staging", {}, { env: state.env });
  const doctor = await doctorBackup(state, agentPath(state), runId);
  openAgent(state).db.exec("UPDATE witness SET value = 'candidate'");
  await restoreUpdateDatabaseBackup({ backup, runId, env: state.env, assertCurrent() {} });
  {
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(at + 1_000);
    finishUpdateRun(runId, { status: "rolled-back" }, { env: state.env });
  }
  const displaced = [state.agentDir(), path.dirname(resolveOpenClawStateSqlitePath(state.env))]
    .flatMap((directory) => fs.readdirSync(directory).map((name) => path.join(directory, name)))
    .filter((file) => file.includes(`.migrated-${runId}`));
  return { runId, doctor, displaced };
}

function bytesOf(files: readonly string[]) {
  return files.reduce((total, file) => total + fs.statSync(file).size, 0);
}

it("removes a rolled-back update's backups after a later verified update and keeps files it cannot prove", async () => {
  await withState(async (state) => {
    const now = Date.now();
    const r1 = await rolledBackUpdate(state, now);
    // The rollback replaced the file the Doctor backup recorded: the old completion check fails.
    const manifestDir = path.join(state.stateDir, "session-sqlite-migration-runs");
    const [manifest] = fs
      .readdirSync(manifestDir)
      .map((name) => readSessionSqliteMigrationManifest(path.join(manifestDir, name))!);
    expect(manifest?.updateRunId).toBe(r1.runId);
    expect(manifest?.targets[0]?.databaseIdentity?.ino).not.toBe(
      String(fs.statSync(agentPath(state), { bigint: true }).ino),
    );
    expect(r1.displaced.some((file) => file.endsWith(".receipt.json"))).toBe(true);
    const removable = [r1.doctor, ...r1.displaced.filter((file) => !file.endsWith(".json"))];
    const freed = bytesOf(removable);

    const stateDb = resolveOpenClawStateSqlitePath(state.env);
    const userBackup = `${stateDb}.bak`;
    const unmanifested = `${agentPath(state)}.pre-startup-migration-${randomUUID()}.bak`;
    const cron = `${stateDb}.doctor-cron-${now}-${randomUUID()}.bak`;
    const unreceipted = `${agentPath(state)}.migrated-${randomUUID()}`;
    for (const file of [userBackup, unmanifested, cron, unreceipted]) {
      fs.writeFileSync(file, "not provably the updater's");
    }
    const foreignRun = await doctorBackup(state, agentPath(state), "no-such-update-run");
    // A manifest from before `updateRunId` keeps its inode-based completion rule.
    const legacy = await doctorBackup(state, agentPath(state));
    // A receipt may name only its own family, never another file beside it.
    const live = fs.statSync(userBackup, { bigint: true });
    fs.writeFileSync(
      path.join(path.dirname(stateDb), `forged.sqlite.migrated-${r1.runId}.receipt.json`),
      JSON.stringify({
        kind: "update-rollback-displaced-database",
        version: 1,
        runId: r1.runId,
        databasePath: path.join(path.dirname(stateDb), "forged.sqlite"),
        files: [
          {
            path: userBackup,
            dev: String(live.dev),
            ino: String(live.ino),
            size: String(live.size),
            mtimeNs: String(live.mtimeNs),
          },
        ],
      }),
    );

    const r2 = startRun(state, now + 60_000);
    const cleanup = await finish(state, r2, now + 61_000, "verified");

    expect([r1.doctor, ...r1.displaced].filter((file) => fs.existsSync(file))).toEqual([]);
    for (const file of [userBackup, unmanifested, cron, unreceipted, foreignRun, legacy]) {
      expect(fs.existsSync(file), file).toBe(true);
    }
    expect(cleanup?.diagnostics).toContainEqual(expect.stringContaining(`Kept ${legacy} (`));
    expect(cleanup?.advisory).toBeUndefined();
    const [summary, ...lines] = cleanup?.diagnostics ?? [];
    expect(summary).toContain(`freed ${formatDiskSpaceBytes(freed)}, ${freed} bytes.`);
    for (const file of [unmanifested, cron, unreceipted, foreignRun]) {
      expect(lines).toContainEqual(expect.stringContaining(`Kept: not provably ours: ${file} (`));
    }
    expect(lines.join("\n")).not.toContain(userBackup + " ");
    expect(summary).toContain("openclaw triage");
  });
});

it("keeps a failed update's newest backup set and releases an older failed set", async () => {
  await withState(async (state) => {
    const now = Date.now();
    const older = startRun(state, now);
    const olderBackup = await doctorBackup(state, agentPath(state), older);
    finishUpdateRun(older, { status: "failed" }, { env: state.env });
    const newest = startRun(state, now + 60_000);
    const newestBackup = await doctorBackup(state, agentPath(state), newest);
    const cleanup = await finish(state, newest, now + 61_000, "failed");
    expect(fs.existsSync(olderBackup)).toBe(false);
    expect(fs.existsSync(newestBackup)).toBe(true);
    expect(cleanup?.diagnostics).toContainEqual(expect.stringContaining(`Kept ${newestBackup} (`));
  });
});

it("keeps backups a pending recovery or an unfinished run references after a verified update", async () => {
  await withState(async (state) => {
    const now = Date.now();
    const unfinished = startRun(state, now);
    const unfinishedBackup = await doctorBackup(state, agentPath(state), unfinished);
    const pending = startRun(state, now + 10_000);
    const pendingBackup = await doctorBackup(state, agentPath(state), pending);
    finishUpdateRun(pending, { status: "rolled-back" }, { env: state.env });
    const verified = startRun(state, now + 60_000);
    const ownBackup = await doctorBackup(state, agentPath(state), verified);
    recordUpdateRunVerification(verified, VERIFIED, { env: state.env });
    finishUpdateRun(verified, { status: "succeeded" }, { env: state.env });
    // A restart observes the older run's unresolved recovery after the verified finish.
    const runtime = {
      root: state.stateDir,
      nodePath: process.execPath,
      version: "1.0.0",
      buildId: null,
    };
    createRetainedUpdateRecovery(
      { runId: pending, from: runtime, to: runtime },
      { env: state.env },
    );
    const cleanup = await automaticallyCleanUpdateRecovery(verified, state.env);
    // The verified update’s own backup goes at once; referenced ones stay.
    expect(fs.existsSync(ownBackup)).toBe(false);
    expect([unfinishedBackup, pendingBackup].map((file) => fs.existsSync(file))).toEqual([
      true,
      true,
    ]);
    expect(cleanup?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`Kept ${pendingBackup} (`),
        expect.stringContaining(`Kept ${unfinishedBackup} (`),
      ]),
    );
  });
});

it("records a failed deletion as a warning without failing the update, and the next cleanup removes it", async () => {
  await withState(async (state) => {
    const now = Date.now();
    const r1 = await rolledBackUpdate(state, now);
    const main = r1.displaced.find((file) => file.endsWith(`.migrated-${r1.runId}`))!;
    const unlink = fs.promises.unlink;
    const refused = vi.spyOn(fs.promises, "unlink").mockImplementation(async (file) => {
      if (String(file) === main) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return unlink(file);
    });
    const r2 = startRun(state, now + 60_000);
    const first = await finish(state, r2, now + 61_000, "verified");
    refused.mockRestore();
    expect(first?.exitCode).toBe(0);
    expect(first?.advisory?.message).toContain(`Could not remove ${main}`);
    expect(fs.existsSync(main)).toBe(true);

    const r3 = startRun(state, now + 120_000);
    const second = await finish(state, r3, now + 121_000, "verified");
    expect(second?.advisory).toBeUndefined();
    expect(r1.displaced.filter((file) => fs.existsSync(file))).toEqual([]);
  });
});

it("keeps a displaced database that changed after the rollback recorded it, with a warning", async () => {
  await withState(async (state) => {
    const now = Date.now();
    const r1 = await rolledBackUpdate(state, now);
    const main = r1.displaced.find((file) => file.endsWith(`.migrated-${r1.runId}`))!;
    // Someone opened the moved-aside database and wrote to it.
    fs.appendFileSync(main, Buffer.alloc(4096));
    const r2 = startRun(state, now + 60_000);
    const cleanup = await finish(state, r2, now + 61_000, "verified");
    expect(fs.existsSync(main)).toBe(true);
    expect(fs.existsSync(`${main}.receipt.json`)).toBe(true);
    expect(cleanup?.exitCode).toBe(0);
    expect(cleanup?.advisory?.message).toContain(`${main} (displaced-database-changed`);
  });
});
