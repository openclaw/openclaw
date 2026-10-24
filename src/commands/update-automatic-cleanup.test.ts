import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { automaticallyCleanUpdateRecovery } from "../cli/update-cli/automatic-cleanup.js";
import { prepareUpdateCommandTerminalResult } from "../cli/update-cli/update-command-terminal.js";
import { finalizeRestartUpdateRun } from "../gateway/server-restart-update-run.js";
import { cleanupGatewayUpdateRecovery } from "../gateway/update-automatic-cleanup.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import {
  createSessionSqliteMigrationRun,
  readSessionSqliteMigrationManifest,
  resolveSessionSqliteMigrationRunsDir,
  writeSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "../infra/update-capture-privacy-marker.js";
import { createRetainedUpdateRecovery } from "../infra/update-retained-recovery.test-support.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import * as updateRunWrites from "../infra/update-run-write.async.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { defaultRuntime } from "../runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import {
  completeDoctorMigrationBackups,
  recordDoctorMigrationBackups,
} from "./doctor-migration-backup-artifacts.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { useDoctorSessionSqliteTestFixture } from "./doctor-session-sqlite.test-support.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const { createVerifiedRecoveryStore } = useDoctorSessionSqliteTestFixture();
let env: NodeJS.ProcessEnv;
let stateDir: string;
let now: number;
beforeEach(() => {
  const home = fs.realpathSync(dirs.make("automatic-recovery-cleanup-"));
  stateDir = path.join(home, "state");
  fs.mkdirSync(stateDir);
  for (const [key, value] of Object.entries({
    HOME: home,
    OPENCLAW_HOME: "",
    OPENCLAW_PROFILE: "",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  })) {
    vi.stubEnv(key, value);
  }
  fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, "{}\n");
  env = { ...process.env };
  now = Date.now();
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await cleanupSessionStateForTest();
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function capture(runId: string, doctor = false, age = 0) {
  const directory = path.join(resolveUpdateCaptureRoot(stateDir), runId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER),
    UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
  );
  fs.writeFileSync(path.join(directory, "payload"), "preserved rollback bytes");
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify(
      doctor
        ? {
            schemaVersion: 2,
            kind: "update-recovery",
            generation: { kind: "baseline" },
            databases: [],
            runId,
            installRoot: stateDir,
            stateDir,
            configPath: env.OPENCLAW_CONFIG_PATH,
            configPaths: [env.OPENCLAW_CONFIG_PATH],
            creator: { host: "fixture", pid: 1, startIdentity: "1" },
            drivers: [],
            createdAt: new Date(now - age * 86_400_000).toISOString(),
            roots: [env.OPENCLAW_CONFIG_PATH],
            excludedRoots: [],
            protectedPaths: [env.OPENCLAW_CONFIG_PATH],
            entries: [
              {
                kind: "missing",
                sourcePath: env.OPENCLAW_CONFIG_PATH,
                sqlite: false,
                directory: false,
              },
            ],
          }
        : {},
    ),
  );
  return directory;
}
function start(at: number) {
  using clock = vi.spyOn(Date, "now");
  clock.mockReturnValue(at);
  return createUpdateRun({ trigger: "cli" }, { env }).runId;
}
async function complete(runId: string, at: number, json = true) {
  using clock = vi.spyOn(Date, "now");
  clock.mockReturnValue(at);
  const emit = await prepareUpdateCommandTerminalResult(
    { opts: { json, run: { runId, env } } },
    { status: "ok", mode: "git", steps: [], durationMs: 1 },
    { rolledBack: false },
  );
  const result = await emit();
  expect(result.status).toBe("ok");
  expect(getUpdateRun(runId, { env })?.status).toBe("succeeded");
  return result;
}

async function migrationOriginal() {
  await closeOpenClawStateDatabaseAsync();
  const source = resolveOpenClawStateSqlitePath(env);
  const backupId = randomUUID();
  const backup = `${source}.pre-startup-migration-${backupId}.bak`;
  await withDoctorSqliteMaintenanceLock({
    env,
    operation: "fixture migration",
    run: () => {
      fs.copyFileSync(source, backup);
      recordDoctorMigrationBackups(env, backupId, [
        { path: source, identity: fs.statSync(source, { bigint: true }), archivePath: backup },
      ]);
      completeDoctorMigrationBackups(env, [source]);
    },
  });
  return backup;
}

it("retires the previous successful generation and migration originals, but retains current and protected recovery", async () => {
  const failed = start(now - 240_000);
  finishUpdateRun(failed, { status: "failed" }, { env });
  const failedCapture = capture(failed);
  const first = start(now - 120_000);
  const firstCapture = capture(first);
  const backup = await migrationOriginal();
  await complete(first, now + 1_000);
  expect(fs.existsSync(firstCapture)).toBe(true);
  expect(fs.existsSync(backup)).toBe(true);
  const doctors = [5, 4, 3, 2, 1].map((age) => capture(`doctor-${randomUUID()}`, true, age));
  const orphan = capture("unmanifested");
  const second = start(now + 60_000);
  const secondCapture = capture(second);
  const result = await complete(second, now + 61_000);
  expect(result.steps.at(-1)?.advisory).toBeUndefined();
  expect(fs.existsSync(firstCapture)).toBe(false);
  expect(fs.existsSync(backup)).toBe(false);
  expect([secondCapture, failedCapture, orphan].map(fs.existsSync)).toEqual([true, true, true]);
  expect(doctors.map(fs.existsSync)).toEqual([false, false, true, true, true]);
  expect(
    result.steps.find((step) => step.name === "recovery-artifact-cleanup")?.advisory,
  ).toBeUndefined();
});

it.each([true, false])(
  "keeps success and reports an actual retirement failure consistently (JSON: %s)",
  async (json) => {
    const first = start(now - 120_000);
    const original = capture(first);
    await complete(first, now - 60_000);
    const second = start(now);
    const rm = fs.promises.rm;
    using failure = vi.spyOn(fs.promises, "rm");
    failure.mockImplementation(async (target, options) => {
      if (String(target).startsWith(original + path.sep)) {
        throw new Error("injected retirement failure");
      }
      return rm(target, options);
    });
    vi.mocked(defaultRuntime.log).mockClear();
    const result = await complete(second, now + 1_000, json);
    expect(fs.existsSync(original)).toBe(true);
    expect(result.steps.at(-1)?.advisory?.message).toContain("injected retirement failure");
    if (json) {
      const output = vi
        .mocked(defaultRuntime.writeJson)
        .mock.calls.at(-1)?.[0] as UpdateRunResult & { run: UpdateRunRecord };
      expect(output.status).toBe("ok");
      expect(output.steps.at(-1)?.advisory?.message).toContain("injected retirement failure");
      expect(output.run.steps).toContainEqual(
        expect.objectContaining({
          step: "warning:recovery-artifact-cleanup",
          detail: expect.stringContaining("injected retirement failure"),
        }),
      );
    } else {
      const printed = vi.mocked(defaultRuntime.log).mock.calls.flat().join("\n");
      expect(printed).toContain("OpenClaw updated; 1 warning needs attention");
      expect(printed).toContain("injected retirement failure");
    }
    expect(getUpdateRun(second, { env })?.steps).toContainEqual(
      expect.objectContaining({
        step: "warning:recovery-artifact-cleanup",
        detail: expect.stringContaining("injected retirement failure"),
      }),
    );
  },
);

it("runs retirement in the owning Gateway worker while manual cleanup still refuses its live lock", async () => {
  const pending = start(now - 240_000);
  const pendingCapture = capture(pending);
  finishUpdateRun(pending, { status: "rolled-back" }, { env });
  const first = start(now - 120_000);
  const original = capture(first);
  finishUpdateRun(first, { status: "succeeded" }, { env });
  const second = start(now + 60_000);
  const current = capture(second);
  {
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(now + 61_000);
    finishUpdateRun(second, { status: "succeeded" }, { env });
  }
  // Persist an actual pending recovery record after terminal history, as on
  // a restart observing old unresolved work. It must never release its capture.
  const runtime = { root: stateDir, nodePath: process.execPath, version: "1.0.0", buildId: null };
  createRetainedUpdateRecovery({ runId: pending, from: runtime, to: runtime }, { env });
  await closeOpenClawStateDatabaseAsync();
  const lock = await acquireGatewayLock({ env, role: "gateway", allowInTests: true });
  expect(lock).toBeTruthy();
  try {
    await expect(
      retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      }),
    ).rejects.toThrow(/ownership|lock/i);
    expect(fs.existsSync(original)).toBe(true);
    const result = await cleanupGatewayUpdateRecovery(second, env, () => lock!.assertCurrent());
    expect(result?.advisory).toBeUndefined();
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.existsSync(pendingCapture)).toBe(true);
    expect(getUpdateRun(second, { env })?.status).toBe("succeeded");
  } finally {
    await lock?.release();
  }
});

it.each(["claim-publication", "first-unlink"] as const)(
  "stops migration-original retirement when its physical owner is replaced after %s",
  async (phase) => {
    const fixture = await createVerifiedRecoveryStore();
    env = fixture.store.env;
    stateDir = fixture.store.stateDir;
    const originals = new Map(
      fixture.target.completedMoves
        .filter((move) => move.artifact?.classification !== "protected")
        .map((move) => [move.archivePath, fs.readFileSync(move.archivePath)]),
    );
    expect(originals.size).toBe(2);
    const runId = start(now);
    const current = capture(runId);
    finishUpdateRun(runId, { status: "succeeded" }, { env });
    await closeOpenClawStateDatabaseAsync();
    const acquire = () =>
      acquireGatewayStateOwner({
        databasePath: resolveOpenClawStateSqlitePath(env),
        payload: {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          configPath: env.OPENCLAW_CONFIG_PATH!,
          role: "gateway",
          processNamespace: readGatewayLockProcessNamespace(),
        },
      });
    const originalOwner = acquire();
    let successor: ReturnType<typeof acquire> | undefined;
    const moves = () =>
      readSessionSqliteMigrationManifest(fixture.manifestPath)!.targets[0]!.completedMoves.filter(
        (move) => originals.has(move.archivePath),
      );
    const remaining = () =>
      moves().flatMap((move) => {
        const disposal = move.artifact!.disposal;
        const retained = fs.existsSync(move.archivePath)
          ? move.archivePath
          : disposal.state === "pending-disposal" && fs.existsSync(disposal.claimPath)
            ? disposal.claimPath
            : undefined;
        return retained ? [{ original: move.archivePath, retained }] : [];
      });
    try {
      const result = await cleanupGatewayUpdateRecovery(runId, env, () => {
        // Observe real worker effects, then replace the real physical owner.
        // Production host admission still decides whether the next effect is allowed.
        const reached =
          phase === "claim-publication"
            ? moves().some(
                (move) =>
                  move.artifact?.disposal.state === "pending-disposal" &&
                  fs.existsSync(move.artifact.disposal.claimPath),
              )
            : remaining().length < originals.size;
        if (!successor && reached) {
          originalOwner.release();
          successor = acquire();
        }
      });
      expect(successor, JSON.stringify(result)).toBeDefined();
      expect(result?.advisory).toBeDefined();
      expect(() => originalOwner.assertCurrent()).toThrow();
      successor!.assertCurrent();
      const retained = remaining();
      expect(retained).toHaveLength(phase === "claim-publication" ? 2 : 1);
      for (const { original, retained: file } of retained) {
        expect(fs.readFileSync(file)).toEqual(originals.get(original));
      }
      if (phase === "claim-publication") {
        for (const [file, bytes] of originals) {
          expect(fs.existsSync(file)).toBe(true);
          expect(fs.readFileSync(file)).toEqual(bytes);
        }
      }
      expect(fs.existsSync(current)).toBe(true);
      expect(getUpdateRun(runId, { env })?.status).toBe("succeeded");
      // Durable partial-disposal receipts remain retryable by the successor owner.
      const retried = await cleanupGatewayUpdateRecovery(runId, env);
      expect(retried?.advisory).toBeUndefined();
      expect(remaining()).toEqual([]);
      expect(fs.existsSync(current)).toBe(true);
      expect(getUpdateRun(runId, { env })?.status).toBe("succeeded");
    } finally {
      originalOwner.release();
      successor?.release();
    }
  },
);

it("does not retire artifacts when another process owns live state", async () => {
  const first = start(now - 120_000);
  const original = capture(first);
  finishUpdateRun(first, { status: "succeeded" }, { env });
  const second = start(now);
  finishUpdateRun(second, { status: "succeeded" }, { env });
  await closeOpenClawStateDatabaseAsync();
  const owner = acquireGatewayStateOwner({ databasePath: resolveOpenClawStateSqlitePath(env) });
  const lockPath = owner.path;
  owner.release();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import { acquireFileLockSync } from "@openclaw/fs-safe/file-lock";
    const pathname = process.argv[1];
    const lock = acquireFileLockSync(pathname, { lockPath: pathname, retry: { retries: 0 },
      payload: () => ({ pid: process.pid, createdAt: new Date().toISOString(), configPath: "synthetic", role: "gateway", processNamespace: ${JSON.stringify(readGatewayLockProcessNamespace())} }) });
    process.on("message", () => { lock.release(); process.disconnect(); });
    process.send("held");
  `,
      lockPath,
    ],
    { env, stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const closed = once(child, "close");
  try {
    await Promise.race([
      once(child, "message"),
      closed.then(() => {
        throw new Error("Foreign owner exited before acquiring its lock");
      }),
    ]);
    const result = await automaticallyCleanUpdateRecovery(second, env);
    expect(result?.advisory?.message).toMatch(/owner|ownership|Gateway/);
    expect(fs.existsSync(original)).toBe(true);
    expect(getUpdateRun(second, { env })?.status).toBe("succeeded");
  } finally {
    if (child.connected) {
      child.send("release");
    } else if (child.exitCode === null) {
      child.kill();
    }
    await closed;
  }
});

it.each(["legacy-store", "transcript"] as const)(
  "keeps the entire mixed-proof recovery set when its %s needs historical verification",
  async (unverifiedKind) => {
    const fixture = await createVerifiedRecoveryStore();
    env = fixture.store.env;
    stateDir = fixture.store.stateDir;
    const originals = new Map(
      fixture.target.completedMoves.map((move) => [
        move.archivePath,
        fs.readFileSync(move.archivePath),
      ]),
    );
    // A supported historical receipt can lack proof for only part of a connected
    // recovery set. Deferring that verification must also retain its dependencies.
    for (const move of [...fixture.target.plannedMoves, ...fixture.target.completedMoves]) {
      if (move.kind === unverifiedKind) {
        delete move.artifact;
      }
    }
    writeSessionSqliteMigrationManifest({
      manifestPath: fixture.manifestPath,
      manifest: fixture.manifest,
    });
    const runId = start(now + 60_000);
    await complete(runId, now + 61_000);
    for (const [file, contents] of originals) {
      expect(fs.existsSync(file), file).toBe(true);
      expect(fs.readFileSync(file)).toEqual(contents);
    }
  },
);

it("keeps the triggering update's capture when the wall clock moves backward", async () => {
  const runId = start(now + 60_000);
  const current = capture(runId);
  const result = await complete(runId, now);
  expect(fs.existsSync(current)).toBe(true);
  expect(result.steps.at(-1)?.advisory?.message).toContain("triggering update");
});

it.each([true, false])(
  "defers cross-manifest disposal even for protected historical originals (completed: %s)",
  async (completed) => {
    const fixture = await createVerifiedRecoveryStore();
    env = fixture.store.env;
    stateDir = fixture.store.stateDir;
    const originals = new Map(
      fixture.target.completedMoves.map((move) => [
        move.archivePath,
        fs.readFileSync(move.archivePath),
      ]),
    );
    const transcript = fixture.target.completedMoves.find((move) => move.kind === "transcript")!;
    const separate = createSessionSqliteMigrationRun(env, []);
    separate.manifest.completedAt = fixture.manifest.completedAt;
    separate.manifest.targets = [
      {
        ...structuredClone(fixture.target),
        plannedMoves: [structuredClone(transcript)],
        completedMoves: [structuredClone(transcript)],
      },
    ];
    writeSessionSqliteMigrationManifest(separate);
    if (!completed) {
      delete fixture.manifest.completedAt;
    }
    fixture.target.plannedMoves = fixture.target.plannedMoves.filter(
      (move) => move.kind !== "transcript",
    );
    fixture.target.completedMoves = fixture.target.completedMoves.filter(
      (move) => move.kind !== "transcript",
    );
    for (const move of [...fixture.target.plannedMoves, ...fixture.target.completedMoves]) {
      if (move.kind === "legacy-store") {
        delete move.artifact;
      }
    }
    writeSessionSqliteMigrationManifest({
      manifestPath: fixture.manifestPath,
      manifest: fixture.manifest,
    });
    const backup = await migrationOriginal();
    const first = start(now - 120_000);
    const oldCapture = capture(first);
    finishUpdateRun(first, { status: "succeeded" }, { env });
    const second = start(now + 60_000);
    await complete(second, now + 61_000);
    for (const [file, contents] of originals) {
      expect(fs.existsSync(file), file).toBe(true);
      expect(fs.readFileSync(file)).toEqual(contents);
    }
    expect(fs.existsSync(backup)).toBe(true);
    // Capture eligibility is independent of deferred session-original dependencies.
    expect(fs.existsSync(oldCapture)).toBe(false);
  },
);

it("keeps Gateway completion warnings visible when cleanup diagnostics cannot be persisted", async () => {
  const first = start(now - 120_000);
  const oldCapture = capture(first);
  finishUpdateRun(first, { status: "succeeded" }, { env });
  const second = start(now + 60_000);
  const current = capture(second);
  {
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(now + 61_000);
    finishUpdateRun(second, { status: "succeeded" }, { env });
  }
  const manifests = resolveSessionSqliteMigrationRunsDir(env);
  fs.mkdirSync(manifests, { recursive: true });
  fs.writeFileSync(path.join(manifests, "unreadable.json"), "invalid recovery metadata");
  await closeOpenClawStateDatabaseAsync();
  const lock = await acquireGatewayLock({ env, role: "gateway", allowInTests: true });
  expect(lock).toBeTruthy();
  using recordFailure = vi.spyOn(updateRunWrites, "recordUpdateRunStepAsync");
  recordFailure.mockRejectedValue(new Error("receipt write unavailable"));
  try {
    const completed = await finalizeRestartUpdateRun({
      kind: "update",
      status: "ok",
      ts: now,
      stats: { runId: second },
    });
    expect(completed?.status).toBe("succeeded");
    expect(completed?.steps).toContainEqual(
      expect.objectContaining({
        step: "warning:recovery-artifact-cleanup",
        detail: expect.stringContaining("receipt write unavailable"),
      }),
    );
    expect(completed?.steps).toContainEqual(
      expect.objectContaining({
        step: "warning:recovery-artifact-cleanup",
        detail: expect.stringContaining("unreadable-manifest"),
      }),
    );
    expect(
      getUpdateRun(second, { env })?.steps.some(
        (step) => step.step === "warning:recovery-artifact-cleanup",
      ),
    ).toBe(false);
    expect(fs.existsSync(oldCapture)).toBe(false);
    expect(fs.existsSync(current)).toBe(true);
  } finally {
    await lock?.release();
  }
});
