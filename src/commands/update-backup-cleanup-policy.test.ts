import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { automaticallyCleanUpdateRecovery } from "../cli/update-cli/automatic-cleanup.js";
import { prepareUpdateCommandTerminalResult } from "../cli/update-cli/update-command-terminal.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatDiskSpaceBytes } from "../infra/disk-space.js";
import {
  readSessionSqliteMigrationManifest,
  writeSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import { discoverUpdateStateSchemaInspectionInProcess } from "../infra/update-candidate-state.js";
import { createUpdateDatabaseBackupInProcess } from "../infra/update-database-backup.js";
import { restoreUpdateDatabaseBackup } from "../infra/update-database-restore.js";
import {
  displacedDatabasePath,
  writeDisplacedDatabaseReceipts,
} from "../infra/update-displaced-database-receipt.js";
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
import {
  type DoctorMigrationBackupFormat,
  doctorMigrationBackupPath,
} from "./doctor-migration-backup-names.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";
import { collectRecoveryDiskUsage } from "./recovery-disk-usage.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const READY = { serviceRunning: true, versionMatch: true, settled: true, readyz: true };
const VERIFIED = { ...READY, channelsReady: true, coreReady: true, pluginErrors: [] };

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

/** The Doctor of update `updateRunId` takes its pre-migration backups, one manifest per run. */
async function doctorBackups(
  state: OpenClawTestState,
  databases: readonly string[],
  updateRunId?: string,
  format: DoctorMigrationBackupFormat = "full",
) {
  await closeOpenClawAgentDatabasesAsync(state.stateDir);
  await closeOpenClawStateDatabaseAsync();
  const backupId = randomUUID();
  const inventory = databases.map((database) => ({
    path: database,
    identity: fs.statSync(database, { bigint: true }),
    archivePath: doctorMigrationBackupPath(database, backupId, format),
  }));
  await withDoctorSqliteMaintenanceLock({
    env: state.env,
    operation: "fixture migration",
    run: () => {
      for (const { path: database, archivePath } of inventory) {
        fs.copyFileSync(database, archivePath);
      }
      const env = updateRunId ? { ...state.env, OPENCLAW_UPDATE_RUN_ID: updateRunId } : state.env;
      recordDoctorMigrationBackups(env, backupId, inventory);
    },
  });
  return inventory.map(({ archivePath }) => archivePath);
}
async function doctorBackup(state: OpenClawTestState, database: string, updateRunId?: string) {
  return (await doctorBackups(state, [database], updateRunId))[0]!;
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
    // An update run id the ledger does not hold as running tags nothing.
    const foreignRun = await doctorBackup(state, agentPath(state), randomUUID());
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
    expect(summary).toContain(`(${freed} logical bytes, ${formatDiskSpaceBytes(freed)}).`);
    expect(cleanup?.diagnostics).toContainEqual(expect.stringContaining(`Kept ${foreignRun} (`));
    for (const file of [unmanifested, cron, unreceipted]) {
      expect(lines).toContainEqual(expect.stringContaining(`Kept: not provably ours: ${file} (`));
    }
    // Cleanup refuses while the Gateway runs, so the hint names that step first.
    expect(lines).toContainEqual(
      expect.stringContaining(
        "or stop the Gateway (openclaw gateway stop) and remove it yourself with openclaw update cleanup --include-unmanifested",
      ),
    );
    expect(lines.join("\n")).not.toContain(userBackup + " ");
    expect(summary).toContain("openclaw triage");
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
    // Each is kept for its own reason, named in the report.
    const kept = (file: string) =>
      cleanup?.diagnostics?.filter((line) => line.startsWith(`Kept ${file} (`));
    expect(kept(pendingBackup)).toEqual([
      expect.stringMatching(/\): a pending update recovery needs it\.$/u),
    ]);
    expect(kept(unfinishedBackup)).toEqual([
      expect.stringMatching(/\): its update run has not finished\.$/u),
    ]);
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

type State = "intact" | "changed" | "missing";
/** Per database: no backup, or a Doctor backup or a rollback's moved-aside family, and its fate. */
type Copy = "none" | `${"doctor" | "displaced"}:${State}`;
type RunSpec = { outcome: "verified" | "failed" | "unfinished"; pending: boolean; copies: Copy[] };

/** Deterministic scenarios: several runs, each with a per-database backup state and outcome. */
function scenario(seed: number): RunSpec[] {
  let value = seed;
  const next = (n: number) => {
    value = (Math.imul(value ^ (value >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    return value % n;
  };
  const copy = (): Copy =>
    next(4) === 0
      ? "none"
      : `${next(2) ? "doctor" : "displaced"}:${(["intact", "changed", "missing"] as const)[next(3)]!}`;
  return Array.from({ length: 2 + next(2) }, () => {
    const outcome = (["verified", "failed", "failed", "failed", "unfinished"] as const)[next(5)]!;
    return { outcome, pending: outcome === "failed" && next(4) === 0, copies: [copy(), copy()] };
  });
}

/** A rollback moved this database family aside: main file plus WAL, with the real receipt. */
async function displacedFamily(database: string, runId: string) {
  const target = displacedDatabasePath(database, runId);
  fs.copyFileSync(database, target);
  fs.writeFileSync(`${target}-wal`, "committed frames");
  await writeDisplacedDatabaseReceipts(
    runId,
    [target, `${target}-wal`].map((file) => ({
      databasePath: database,
      target: file,
      identity: fs.statSync(file, { bigint: true }),
    })),
  );
  return target;
}

it.each([
  // Each newer run is intact only for the other database, or keeps only a WAL member.
  ...(
    [
      ["none", "doctor:intact", "doctor:intact", "doctor:changed"],
      ["none", "displaced:intact", "doctor:intact", "displaced:missing"],
    ] as const
  ).map(([a, b, c, d]) => ({
    name: `newer run intact only for another database (${b}, ${d})`,
    runs: [
      { outcome: "failed", pending: false, copies: [a, b] },
      { outcome: "failed", pending: false, copies: [c, d] },
    ] as RunSpec[],
  })),
  // The agent's live database is gone; even a verified update releases none of its copies.
  ...(["displaced:intact", "doctor:intact"] as const).map((copy) => ({
    name: `live database missing (${copy})`,
    runs: [{ outcome: "verified", pending: false, copies: ["none", copy] }] as RunSpec[],
    liveMissing: true,
  })),
  ...Array.from({ length: 20 }, (_, index) => ({
    name: `seed ${index + 1}`,
    runs: scenario(index + 1),
    liveMissing: index % 4 === 3,
  })),
])(
  "keeps an intact backup of every database no verified update superseded ($name)",
  async ({ runs, liveMissing }: { runs: RunSpec[]; liveMissing?: boolean }) => {
    await withState(async (state) => {
      const now = Date.now();
      const databases = [resolveOpenClawStateSqlitePath(state.env), agentPath(state)];
      const made: { run: number; database: number; file: string; copy: Copy }[] = [];
      for (const [index, spec] of runs.entries()) {
        const runId = startRun(state, now + index * 60_000);
        const doctor = databases.filter((_, d) => spec.copies[d]!.startsWith("doctor"));
        const files = doctor.length ? await doctorBackups(state, doctor, runId) : [];
        for (const [d, database] of databases.entries()) {
          const copy = spec.copies[d]!;
          if (copy !== "none") {
            const file = copy.startsWith("doctor")
              ? files[doctor.indexOf(database)]!
              : await displacedFamily(database, runId);
            made.push({ run: index, database: d, file, copy });
          }
        }
        using clock = vi.spyOn(Date, "now");
        clock.mockReturnValue(now + index * 60_000 + 1_000);
        if (spec.outcome === "verified") {
          recordUpdateRunVerification(runId, VERIFIED, { env: state.env });
          finishUpdateRun(runId, { status: "succeeded" }, { env: state.env });
        } else if (spec.outcome === "failed") {
          finishUpdateRun(runId, { status: "failed" }, { env: state.env });
        }
        if (spec.pending) {
          const runtime = { root: state.stateDir, nodePath: process.execPath, version: "1.0.0" };
          createRetainedUpdateRecovery(
            { runId, from: { ...runtime, buildId: null }, to: { ...runtime, buildId: null } },
            { env: state.env },
          );
        }
      }
      if (liveMissing) {
        await closeOpenClawAgentDatabasesAsync(state.stateDir);
        for (const suffix of ["", "-wal", "-shm"]) {
          fs.rmSync(`${databases[1]}${suffix}`, { force: true });
        }
      }
      for (const { file, copy } of made) {
        if (copy.endsWith(":changed")) {
          fs.appendFileSync(file, Buffer.alloc(4096));
        } else if (copy.endsWith(":missing")) {
          fs.unlinkSync(file);
        }
      }
      // Invariant: a database with an intact backup and no verified update from that run on
      // keeps at least one intact backup; one whose live database is missing keeps them all.
      const verifiedFrom = (run: number) =>
        runs.some((spec, later) => later >= run && spec.outcome === "verified");
      const intact = (database: number) =>
        made.filter((b) => b.database === database && b.copy.endsWith(":intact"));
      const owed = [0, 1].filter((d) => intact(d).some((b) => !verifiedFrom(b.run)));
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      await closeOpenClawStateDatabaseAsync();
      await retireSessionSqliteRecovery({
        env: state.env,
        preview: await inspectSessionSqliteRecovery({ cfg: {}, env: state.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      for (const database of owed) {
        expect(
          intact(database).some((b) => fs.existsSync(b.file)),
          `database ${database} lost its last intact backup: ${JSON.stringify(runs)}`,
        ).toBe(true);
      }
      if (liveMissing) {
        expect(intact(1).filter((b) => !fs.existsSync(b.file))).toEqual([]);
      }
    });
  },
);

async function cleanUpWith(state: OpenClawTestState, cfg: OpenClawConfig = {}) {
  await closeOpenClawAgentDatabasesAsync(state.stateDir);
  await closeOpenClawStateDatabaseAsync();
  return retireSessionSqliteRecovery({
    env: state.env,
    preview: await inspectSessionSqliteRecovery({ cfg, env: state.env }),
    readConfig: async () => cfg,
    confirm: async () => true,
  });
}

function verifiedRun(state: OpenClawTestState, at: number) {
  const runId = startRun(state, at);
  using clock = vi.spyOn(Date, "now");
  clock.mockReturnValue(at + 1_000);
  recordUpdateRunVerification(runId, VERIFIED, { env: state.env });
  finishUpdateRun(runId, { status: "succeeded" }, { env: state.env });
  return runId;
}

it("releases receipted families that are partial, remounted, or in a configured agent directory", async () => {
  await withState(async (state) => {
    const now = Date.now();
    const r1 = await rolledBackUpdate(state, now);
    // A cleanup already removed the agent family's main file; its WAL and receipt remain.
    fs.unlinkSync(r1.displaced.find((file) => file.endsWith(`agent.sqlite.migrated-${r1.runId}`))!);
    // A reboot renumbered the volume: the shared receipt names another device.
    const receipt = r1.displaced.find((file) =>
      /openclaw\.sqlite\.migrated-.*\.receipt\.json$/u.test(file),
    )!;
    const recorded = JSON.parse(fs.readFileSync(receipt, "utf8"));
    for (const file of recorded.files) {
      file.dev = String(BigInt(file.dev) + 7n);
    }
    fs.writeFileSync(receipt, JSON.stringify(recorded));
    const agentDir = path.join(state.stateDir, "custom-agents", "work");
    fs.mkdirSync(agentDir, { recursive: true });
    const custom = path.join(agentDir, "openclaw-agent.sqlite");
    fs.copyFileSync(agentPath(state), custom);
    const family = await displacedFamily(custom, r1.runId);
    verifiedRun(state, now + 60_000);
    await cleanUpWith(state, { agents: { list: [{ id: "work", agentDir }] } } as OpenClawConfig);
    const left = [...r1.displaced, family, `${family}-wal`, `${family}.receipt.json`];
    expect(left.filter((file) => fs.existsSync(file))).toEqual([]);
  });
});

it("keeps a released backup while its live database is missing", async () => {
  await withState(async (state) => {
    const now = Date.now();
    const runId = startRun(state, now);
    const backup = await doctorBackup(state, agentPath(state), runId);
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(now + 1_000);
    recordUpdateRunVerification(runId, VERIFIED, { env: state.env });
    finishUpdateRun(runId, { status: "succeeded" }, { env: state.env });
    clock.mockRestore();
    await closeOpenClawAgentDatabasesAsync(state.stateDir);
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(`${agentPath(state)}${suffix}`, { force: true });
    }
    const report = await cleanUpWith(state);
    expect(fs.existsSync(backup)).toBe(true);
    expect(report.artifacts.find((item) => item.path === backup)?.outcome).toBe("blocked");
  });
});

it("keeps an older backup when the newer one no longer matches its recorded content", async () => {
  await withState(async (state) => {
    const now = Date.now();
    const failedRun = async (at: number) => {
      const runId = startRun(state, at);
      const backup = await doctorBackup(state, agentPath(state), runId);
      finishUpdateRun(runId, { status: "failed" }, { env: state.env });
      return backup;
    };
    const older = await failedRun(now);
    const newer = await failedRun(now + 60_000);
    // Same inode, length and time as recorded, but not the recorded bytes.
    const manifestDir = path.join(state.stateDir, "session-sqlite-migration-runs");
    for (const manifestPath of fs.readdirSync(manifestDir).map((n) => path.join(manifestDir, n))) {
      const manifest = readSessionSqliteMigrationManifest(manifestPath)!;
      const target = manifest.targets[0]!;
      if (target.completedMoves[0]!.archivePath === newer) {
        for (const move of [...target.plannedMoves, ...target.completedMoves]) {
          move.artifact!.identity.sha256 = "0".repeat(64);
        }
        writeSessionSqliteMigrationManifest({ manifestPath, manifest });
      }
    }
    await cleanUpWith(state);
    expect(fs.existsSync(older)).toBe(true);
  });
});

it("leaves content-dependent eligibility unverified in the bounded status scan", async () => {
  await withState(async (state) => {
    const now = Date.now();
    for (const at of [now, now + 60_000]) {
      const runId = startRun(state, at);
      await doctorBackup(state, agentPath(state), runId);
      finishUpdateRun(runId, { status: "failed" }, { env: state.env });
    }
    await closeOpenClawAgentDatabasesAsync(state.stateDir);
    await closeOpenClawStateDatabaseAsync();
    // Releasing the older backup would need the newer one's content hashed; status never does.
    // A frozen clock keeps the scan inside its time budget so only that rule decides.
    using clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const usage = await collectRecoveryDiskUsage({ cfg: {}, env: state.env });
    clock.mockRestore();
    expect(usage.incomplete).toBe(false);
    expect(usage.byKind.migrationOriginals.retirable.count).toBe(0);
    expect(usage.byKind.migrationOriginals.protected.count).toBe(2);
  });
});

it("keeps an older full backup when the newer one is table-scoped", async () => {
  await withState(async (state) => {
    const now = Date.now();
    const olderRun = startRun(state, now);
    const older = await doctorBackup(state, agentPath(state), olderRun);
    finishUpdateRun(olderRun, { status: "failed" }, { env: state.env });
    const newerRun = startRun(state, now + 60_000);
    // A scoped image holds only the tables one migration touched.
    const scoped = (await doctorBackups(state, [agentPath(state)], newerRun, "scoped"))[0]!;
    finishUpdateRun(newerRun, { status: "failed" }, { env: state.env });
    await cleanUpWith(state);
    expect([older, scoped].filter((file) => fs.existsSync(file))).toEqual([older, scoped]);
  });
});

it("leaves a Doctor backup untagged when its update run already finished", async () => {
  await withState(async (state) => {
    const now = Date.now();
    const finished = verifiedRun(state, now);
    // A standalone repair inherited the finished run's id from its environment.
    const repair = await doctorBackup(state, agentPath(state), finished);
    const manifestDir = path.join(state.stateDir, "session-sqlite-migration-runs");
    const [manifest] = fs
      .readdirSync(manifestDir)
      .map((name) => readSessionSqliteMigrationManifest(path.join(manifestDir, name))!);
    expect(manifest?.updateRunId).toBeUndefined();
    await cleanUpWith(state);
    expect(fs.existsSync(repair)).toBe(true);
  });
});

it("does not offer a moved-aside family for removal while its live database is missing", async () => {
  await withState(async (state) => {
    const now = Date.now();
    const runId = startRun(state, now);
    const family = await displacedFamily(agentPath(state), runId);
    finishUpdateRun(runId, { status: "failed" }, { env: state.env });
    verifiedRun(state, now + 60_000);
    await closeOpenClawAgentDatabasesAsync(state.stateDir);
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(`${agentPath(state)}${suffix}`, { force: true });
    }
    const preview = await inspectSessionSqliteRecovery({ cfg: {}, env: state.env });
    const outcomes = preview.artifacts
      .filter((item) => item.path.startsWith(family))
      .map((item) => item.outcome);
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes).not.toContain("candidate");
  });
});
