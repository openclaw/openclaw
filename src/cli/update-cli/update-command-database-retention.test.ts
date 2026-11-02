import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-swap-contract.js";
import { swapStagedPackageInstall } from "../../infra/package-update-swap.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import * as databaseBackup from "../../infra/update-database-backup.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
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
    updateInstallKind: installKind,
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
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
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

it.each([
  { restorable: false, lateRefusal: false, outcome: "success" },
  { restorable: true, lateRefusal: false, outcome: "success" },
  { restorable: true, lateRefusal: true, outcome: "success" },
  { restorable: true, lateRefusal: true, outcome: "failure" },
  { restorable: true, lateRefusal: false, outcome: "rollback" },
])(
  "retains recovery snapshots: restorable=$restorable, lateRefusal=$lateRefusal, outcome=$outcome",
  async ({ restorable, lateRefusal, outcome }) => {
    const base = await fs.realpath(dirs.make("update-database-retention-"));
    const fixture = await createPackageSwapFixture(base);
    const stateDir = path.join(base, "state");
    const source = path.join(stateDir, "state/openclaw.sqlite");
    await fs.mkdir(stateDir);
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
    let snapshotPath = "";
    // Snapshot generation is tested by update-database-backup; exercise its
    // sealed/unsealed result through real capture admission and package retirement.
    vi.spyOn(databaseBackup, "createUpdateDatabaseBackup").mockImplementation(async (input) => {
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
    const execution = captureExecution(fixture.packageRoot, env, "package");
    let transaction: PackageUpdateTransaction | undefined;
    let capture: Awaited<ReturnType<typeof captureUpdateDatabases>> | undefined;
    const result = await swapStagedPackageInstall({
      ...fixture.params,
      onTransaction: async (value) => {
        transaction = value;
        capture = await captureUpdateDatabases({
          transaction: value,
          execution,
          context: undefined,
          assertCurrent: () => {},
        });
      },
    });
    expect(result.status, result.step.stderrTail ?? "").toBe("committed");
    expect(Boolean(capture?.backup)).toBe(restorable);
    const finalResult: UpdateRunResult = {
      status: outcome === "success" ? "ok" : "error",
      mode: "npm",
      root: fixture.packageRoot,
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
        root: fixture.packageRoot,
        opts: { json: true },
      },
      finalResult,
      () => {},
    );
    if (restorable && !lateRefusal && outcome === "success") {
      await expect(fs.stat(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
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
