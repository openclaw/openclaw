import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createNpmTarget } from "../../infra/package-update-steps.test-support.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-swap-contract.js";
import { swapStagedPackageInstall } from "../../infra/package-update-swap.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import { UpdateCaptureSpaceError } from "../../infra/update-capture-space.js";
import * as databaseBackup from "../../infra/update-database-backup.js";
import { createGitRuntimeTransaction } from "../../infra/update-runner-git-runtime.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import * as snapshotBackup from "../../snapshot/database-backup.js";
import { captureUpdateDatabases } from "./update-command-database-backup.js";
import { recordUpdateDatabaseWrites } from "./update-command-database-receipts.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import { recordUpdatePackageCompletion } from "./update-command-terminal.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function captureExecution(
  root: string,
  env: NodeJS.ProcessEnv,
  installKind: "package" | "git",
): MutableUpdateExecutionParams {
  return {
    root,
    installKind,
    ...(installKind === "package"
      ? {
          updateInstallKind: installKind,
          packageInstallTarget: createNpmTarget(path.dirname(root)),
        }
      : { updateInstallKind: installKind }),
    switchToGit: false,
    timeoutMs: 30_000,
    updateStepTimeoutMs: 30_000,
    startedAt: 1,
    progress: {},
    executionGuards: {
      recordPhase: async () => {},
      recordStep: async () => undefined,
      captureWriteOptions: () => {
        throw new Error("Unexpected ledger write");
      },
      onStateHandoff: () => {},
      admitExecutor: () => {},
      assertCurrent: () => {},
      waitForCurrent: async () => {},
      assertBoundChildCurrent: () => {},
    },
    stop: () => {},
    channel: "stable",
    tag: "2.0.0",
    opts: { run: { runId: "snapshot-retention", env } },
    shouldRestart: true,
    packageInstallSpec: "openclaw@2.0.0",
    managedServiceRootRedirect: null,
    recoveryState: { triageTarget: { env } },
    prepareMutableUpdate: async () => {},
  };
}

async function captureEnvironment(stateDir: string) {
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  };
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
  return env;
}

it.runIf(process.platform !== "win32").each([false, true])(
  "captures Git update databases in physical artifact storage (redirected: %s)",
  async (redirected) => {
    const base = await fs.realpath(dirs.make("update-database-artifacts-"));
    const root = path.join(base, "install");
    const stateDir = path.join(base, "state");
    const artifactRoot = path.join(root, ".artifacts");
    const physicalArtifacts = redirected ? path.join(base, "external-artifacts") : artifactRoot;
    await fs.mkdir(root);
    await fs.mkdir(physicalArtifacts);
    if (redirected) {
      await fs.symlink(physicalArtifacts, artifactRoot, "dir");
    }
    await fs.mkdir(path.join(stateDir, "state"), { recursive: true });
    const env = await captureEnvironment(stateDir);
    {
      using db = new DatabaseSync(path.join(stateDir, "state/openclaw.sqlite"));
      db.exec("CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES ('synthetic');");
    }
    const capture = await captureUpdateDatabases({
      transaction: {
        backupRoot: path.join(base, "runtime.backup"),
        rollback: async () => {
          throw new Error("Unexpected rollback");
        },
        complete: async () => {
          throw new Error("Unexpected completion");
        },
      },
      execution: captureExecution(root, env, "git"),
      context: undefined,
      assertCurrent: () => {},
    });
    expect(capture.step.exitCode).toBe(0);
    expect(capture.backup?.directory).toBe(
      path.join(physicalArtifacts, "runtime.backup.databases"),
    );
    expect(capture.backup?.databases).toHaveLength(1);
    using snapshot = new DatabaseSync(capture.backup!.databases[0]!.snapshotPath, {
      readOnly: true,
    });
    expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(snapshot.prepare("SELECT value FROM payload").all()).toEqual([{ value: "synthetic" }]);
  },
);

function captureWith(base: string, root: string, env: NodeJS.ProcessEnv) {
  return captureUpdateDatabases({
    transaction: {
      backupRoot: path.join(base, "runtime.backup"),
      rollback: async () => {
        throw new Error("Unexpected rollback");
      },
      complete: async () => {
        throw new Error("Unexpected completion");
      },
    },
    execution: captureExecution(root, env, "package"),
    context: undefined,
    assertCurrent: () => {},
  });
}

const shortfall = () =>
  new UpdateCaptureSpaceError("short", {
    requiredBytes: 3 * 1024 ** 3,
    availableBytes: 1024 ** 3,
    volume: "backup",
  });

it("skips the pre-migration image and continues when the owner measures a shortfall", async () => {
  const base = await fs.realpath(dirs.make("update-database-skip-"));
  const root = path.join(base, "install");
  await fs.mkdir(root);
  const env = await captureEnvironment(path.join(base, "state"));
  const directory = path.join(base, "runtime.backup.databases");
  vi.spyOn(databaseBackup, "createUpdateDatabaseBackup").mockImplementation(async () => {
    // The owner created its directory exclusively, then measured before any copy.
    await fs.mkdir(directory);
    throw new Error(`Capture failed. Database backup files retained at ${directory}.`, {
      cause: shortfall(),
    });
  });

  const capture = await captureWith(base, root, env);

  expect(capture.backup).toBeUndefined();
  expect(capture.step).toMatchObject({ name: "database snapshot", exitCode: 0 });
  expect(capture.step.warnings).toEqual([
    `No pre-migration database image: it needs 3.0 GiB near ${directory} and 1.0 GiB is free. Without it, the previous version cannot be restored once the new version's database migration commits; a failed update then stays on the new version and is fixed forward. The update continues.`,
  ]);
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
  { cause: "an integrity failure", error: () => new Error("synthetic integrity failure") },
  {
    // A copy that ran out of room has started; its owner did not measure and settle it.
    cause: "a disk that filled mid-copy",
    error: () =>
      Object.assign(new Error("write copy stage: No space left on device"), { code: "ENOSPC" }),
  },
  {
    cause: "a shortfall joined by a cleanup failure",
    error: () =>
      new AggregateError([shortfall(), new Error("staging cleanup did not settle")], "both", {
        cause: shortfall(),
      }),
  },
])("still fails the update for $cause", async ({ error }) => {
  const base = await fs.realpath(dirs.make("update-database-skip-"));
  const root = path.join(base, "install");
  await fs.mkdir(root);
  const env = await captureEnvironment(path.join(base, "state"));
  const failure = error();
  vi.spyOn(databaseBackup, "createUpdateDatabaseBackup").mockRejectedValue(failure);

  await expect(captureWith(base, root, env)).rejects.toBe(failure);
});

it.each(
  (["git", "package"] as const).flatMap((kind) =>
    [
      { restorable: false, lateRefusal: false, outcome: "success" },
      { restorable: true, lateRefusal: false, outcome: "success" },
      { restorable: true, lateRefusal: false, outcome: "success", discardFails: true },
      { restorable: true, lateRefusal: true, outcome: "success" },
      { restorable: true, lateRefusal: true, outcome: "failure" },
      { restorable: true, lateRefusal: false, outcome: "failure" },
      ...(kind === "package"
        ? [{ restorable: true, lateRefusal: false, outcome: "rollback" }]
        : []),
    ].map((scenario) => Object.assign(scenario, { kind })),
  ),
)(
  "retains $kind snapshots: restorable=$restorable, lateRefusal=$lateRefusal, outcome=$outcome, discardFails=$discardFails",
  async ({ kind, restorable, lateRefusal, outcome, discardFails }) => {
    const base = await fs.realpath(dirs.make("update-database-retention-"));
    const fixture = await createPackageSwapFixture(base);
    const root = fixture.packageRoot;
    const stateDir = path.join(base, "state");
    const source = path.join(stateDir, "state/openclaw.sqlite");
    const env = await captureEnvironment(stateDir);
    let snapshotPath = "";
    // Snapshot generation has its own tests; retain both real transaction lifecycles here.
    vi.spyOn(databaseBackup, "createUpdateDatabaseBackup").mockImplementation(async (input) => {
      // Server captures are opt-in; this config leaves them portable.
      expect(input.postgresSchemaCaptures).toBe(false);
      const directory = `${input.backupRoot}.databases`;
      snapshotPath = path.join(directory, "snapshot.sqlite");
      await fs.mkdir(directory);
      await fs.writeFile(snapshotPath, "pre-migration bytes");
      return {
        directory,
        databases: [
          { path: source, snapshotPath, userVersion: 20, sha256: "0".repeat(64), sizeBytes: 19 },
        ],
        missingPaths: [],
        sourcePaths: [source],
        sourceGenerations: restorable ? { [source]: "captured-generation" } : {},
        warnings: [],
      };
    });
    const discard = vi
      .spyOn(snapshotBackup, "discardPostgresSchemaCaptures")
      .mockImplementation(async () => {
        if (discardFails) {
          throw new Error("synthetic capture drop failure");
        }
      });
    let transaction: PackageUpdateTransaction | undefined;
    let capture: Awaited<ReturnType<typeof captureUpdateDatabases>> | undefined;
    const onTransaction = async (value: PackageUpdateTransaction) => {
      transaction = value;
      capture = await captureUpdateDatabases({
        transaction: value,
        execution: captureExecution(root, env, kind),
        context: undefined,
        assertCurrent: () => {},
      });
    };
    if (kind === "git") {
      await onTransaction(
        createGitRuntimeTransaction({
          root,
          promotion: {
            backupRoot: path.join(base, "dist-runtime.openclaw-update-id.tmp"),
            cleanup: async () => undefined,
          },
          assertRollbackSafe: async () => {},
          restoreRuntime: async () => {
            throw new Error("Unexpected rollback");
          },
        }),
      );
    } else {
      const result = await swapStagedPackageInstall({ ...fixture.params, onTransaction });
      expect(result.status, result.step.stderrTail ?? "").toBe("committed");
    }
    const finalResult: UpdateRunResult = {
      status: outcome === "success" ? "ok" : "error",
      mode: kind === "git" ? "git" : "npm",
      root,
      steps: [capture!.step],
      durationMs: 0,
    };
    for (const name of lateRefusal ? ["first", "second"] : []) {
      const backup = capture!.backup!;
      finalResult.steps.push(
        recordUpdateDatabaseWrites(
          backup,
          {
            fromGenerations: backup.sourceGenerations,
            generations: { [source]: "changed-during-doctor" },
            unchanged: false,
          },
          { name },
        ),
      );
      expect(finalResult.steps.at(-1)?.warnings).toContain(
        `Automatic database restoration unavailable: databases changed after snapshot capture; the writer is unknown. Snapshots retained at ${backup.directory}.`,
      );
      expect(finalResult.steps.at(-1)?.diagnostics?.join("\n")).toContain("Doctor interval first;");
    }
    if (outcome === "rollback") {
      expect((await transaction!.rollback(() => {})).exitCode).toBe(0);
      finalResult.recovery = {
        serviceRestartSafe: true,
        version: "1.0.0",
        packageRollbackVerified: true,
      };
    }
    await recordUpdatePackageCompletion(
      {
        packageTransaction: transaction,
        databaseBackup: capture?.backup,
        root,
        opts: { json: true },
      },
      finalResult,
      () => {},
    );
    const retired = restorable && !lateRefusal && outcome === "success";
    // Server-side captures are dropped only where their snapshots retire, and first.
    expect(discard).toHaveBeenCalledTimes(retired ? 1 : 0);
    if (retired && discardFails) {
      // A failed drop keeps the manifests and reports the pending cleanup.
      expect(JSON.stringify(finalResult.steps.at(-1))).toContain(
        "PostgreSQL capture cleanup remains pending",
      );
    }
    if (retired && !discardFails) {
      await expect(
        fs.stat(kind === "git" ? path.dirname(snapshotPath) : snapshotPath),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await fs.readFile(snapshotPath, "utf8")).toBe("pre-migration bytes");
    }
    if (!restorable) {
      expect(capture?.step.warnings).toEqual([
        expect.stringContaining("even after successful activation"),
      ]);
      expect(capture?.step.diagnostics?.[0]).toContain(
        "remain available after successful activation",
      );
    }
  },
);
