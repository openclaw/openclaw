import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, vi } from "vitest";
import { createConfigIO } from "../../config/io.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import { createRetainedPackageSwap } from "../../infra/package-update-swap.test-support.js";
import { resolveSqliteDatabaseFilePath } from "../../infra/sqlite-database-admission.js";
import { createUpdateRun, finishUpdateRun } from "../../infra/update-run-ledger.js";
import * as childCommands from "../../process/exec-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import type { MigratedUpdateFinalizationInput } from "./update-command-migrated-types.js";
import { continueMigratedUpdateInFreshProcess } from "./update-command-migrated.js";
import { readMigratedUpdateRunRow } from "./update-command-migrated.test-support.js";
import { taskRecovery } from "./update-command-post-update.test-support.js";
import {
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";

export type MigratedPackageFinalizationCase = {
  pending: boolean;
  status: "ok" | "error" | "skipped";
  candidateStartAttempted?: boolean;
  backup?: boolean;
  windows?: boolean;
  handback?: boolean;
  completion?: "success" | "failure";
  recovered?: boolean;
  diagnostics?: "truncated" | "interrupted" | "incomplete";
};

export async function expectMigratedPackageFinalization(
  base: string,
  {
    pending,
    status,
    candidateStartAttempted,
    backup,
    windows = false,
    handback = false,
    completion,
    recovered = false,
    diagnostics,
  }: MigratedPackageFinalizationCase,
) {
  const exitCode = status === "error" ? 1 : 0;
  const reason =
    status === "ok"
      ? "updated"
      : status === "skipped"
        ? "gateway-readiness-unverified"
        : "doctor-failed";
  const { transaction, packageRoot } = await createRetainedPackageSwap(base);
  const env = { OPENCLAW_STATE_DIR: path.join(base, "state") };
  const run = {
    runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
    env,
    activationTimeoutMs: 90_000,
  };
  const configSnapshot = await createConfigIO({ env, observe: false }).readConfigFileSnapshot();
  const windowsRecovery = taskRecovery();
  const settlePackage = transaction.complete.bind(transaction);
  const complete = vi.spyOn(transaction, "complete");
  const rollback = vi.spyOn(transaction, "rollback");
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderrChunks: Buffer[] = [];
  if (diagnostics) {
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return false;
    });
  }
  const progress = Buffer.from("finalizing 🦊\n");
  const cancellation = Buffer.from("finalizer interrupted\n");
  const padding = diagnostics === "truncated" ? "x".repeat(1024 * 1024) : "";
  const incomplete = Buffer.from([0xf0, 0x9f]);
  const expectedProgress = Buffer.concat([
    progress,
    Buffer.from(padding),
    ...(diagnostics === "incomplete" ? [incomplete] : []),
  ]);
  let observedProgress = Buffer.alloc(0);
  const onResult = vi.fn();
  if (recovered) {
    windowsRecovery.complete.mockImplementationOnce(async () => {
      expect(stdout).not.toHaveBeenCalled();
      expect(onResult).not.toHaveBeenCalled();
    });
  }
  let stdoutAtCompletion: number | undefined;
  let observedAtCompletion: number | undefined;
  let candidateRow: unknown;
  const oldRuntimeOpens: string[] = [];
  const databasePath = path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
  const readCandidateRow = () => readMigratedUpdateRunRow(databasePath, run.runId);
  if (completion) {
    // Keep the successful package owner's real completion; inject only the
    // ordinary error that the canonical completion policy must classify.
    complete.mockImplementation(async (...args) => {
      stdoutAtCompletion = stdout.mock.calls.length;
      observedAtCompletion = onResult.mock.calls.length;
      if (completion === "failure") {
        throw new Error("fixture package completion unavailable");
      }
      return await settlePackage(...args);
    });
  }
  // Keep the real parent and package owner; model only the completed candidate's JSON reply.
  vi.spyOn(childCommands, "runUtf8CommandBuffersWithTimeout").mockImplementation(
    async (_argv, options) => {
      if (typeof options === "number" || typeof options.input !== "string") {
        throw new Error("Expected serialized finalization input");
      }
      const input: MigratedUpdateFinalizationInput = JSON.parse(options.input);
      expect(input.params).not.toHaveProperty("databaseBackup");
      if (diagnostics) {
        // Fixed process I/O: a split UTF-8 progress line, followed by bytes the
        // runner drains after observation stops during cancellation.
        expect(options.onOutputChunk?.(progress.subarray(0, 12), "stderr")).toBeUndefined();
        expect(options.onOutputChunk?.(progress.subarray(12), "stderr")).toBeUndefined();
        if (padding) {
          options.onOutputChunk?.(Buffer.from(padding), "stderr");
        }
        if (diagnostics === "incomplete") {
          options.onOutputChunk?.(incomplete, "stderr");
        }
        observedProgress = Buffer.concat(stderrChunks);
        const captured = Buffer.concat([expectedProgress, cancellation]);
        const tail = captured.subarray(-1024 * 1024);
        // A cancelled candidate publishes neither a terminal row nor a result artifact.
        return {
          stdout: Buffer.alloc(0),
          stderr: tail,
          windowsEncoding: null,
          stderrTruncatedBytes: captured.byteLength - tail.byteLength,
          code: 124,
          signal: null,
          killed: true,
          termination: "timeout",
          cleanup: "cooperative",
        };
      }
      const result = {
        ...input.params.result,
        status,
        reason,
        runId: run.runId,
        ...(recovered
          ? { recovery: { serviceRestartSafe: true, version: "2.0.0", service: "healthy" } }
          : {}),
        steps: pending
          ? [
              {
                name: "gateway verification",
                command: "gateway verification",
                cwd: packageRoot,
                durationMs: 90_000,
                exitCode: 0,
                termination: "timeout",
                advisory: {
                  kind: "recoverable-maintenance",
                  message:
                    "Gateway is still starting after 90000ms; left running with readiness unverified.",
                },
              },
            ]
          : [],
      };
      finishUpdateRun(
        run.runId,
        {
          status: status === "ok" ? "succeeded" : status === "skipped" ? "skipped" : "failed",
          reason,
        },
        { env },
      );
      if (completion) {
        candidateRow = readCandidateRow();
        await closeStateDatabaseForTest();
        const migrated = new DatabaseSync(databasePath);
        migrated.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
        migrated.close();
        const controlPath = path.join(base, "observer-control.sqlite");
        new DatabaseSync(controlPath).close();
        const migratedStateLocation = nodeSqlite.resolveNodeSqliteLocation(databasePath);
        const open = nodeSqlite.openNodeSqliteDatabase;
        const observedOpen = vi
          .spyOn(nodeSqlite, "openNodeSqliteDatabase")
          .mockImplementation((...args) => {
            const openedPath = nodeSqlite.resolveNodeSqliteLocation(
              resolveSqliteDatabaseFilePath(args[0]),
            );
            if (openedPath === migratedStateLocation) {
              oldRuntimeOpens.push(args[0]);
            }
            return open(...args);
          });
        // Exercise the observer with the native SQLite filename URI without
        // reopening the migrated state database in the old runtime.
        const controlUri = nodeSqlite.resolveExistingSqliteFileUri(controlPath);
        const control = nodeSqlite.openNodeSqliteDatabase(controlUri);
        try {
          expect(observedOpen).toHaveBeenCalledExactlyOnceWith(controlUri);
        } finally {
          control.close();
        }
      }
      await fs.writeFile(
        input.resultPath,
        JSON.stringify({ result, exitCode, terminalRunId: run.runId, candidateStartAttempted }),
      );
      return {
        stdout: Buffer.from("candidate finalization result\n"),
        stderr: Buffer.alloc(0),
        windowsEncoding: null,
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
        cleanup: "normal",
      };
    },
  );

  const continueUpdate = () =>
    continueMigratedUpdateInFreshProcess(
      {
        mutationStarted: true,
        result: { status: "ok", mode: "npm", root: packageRoot, steps: [], durationMs: 1 },
        root: packageRoot,
        installKindChanged: false,
        configSnapshot,
        requestedChannel: null,
        storedChannel: "stable",
        channel: "stable",
        downgradeRisk: false,
        shouldRestart: true,
        opts: { json: true, run },
        preManagedServiceStop: {
          stopped: true,
          inspected: true,
          runtimeInspected: true,
          running: true,
          serviceEnv: env,
          ...(windows ? { windowsTaskAutoStartRecovery: windowsRecovery } : {}),
        },
        packageTransaction: transaction,
        ...(backup
          ? {
              databaseBackup: {
                directory: path.join(transaction.backupRoot, "databases"),
                databases: [],
                missingPaths: [],
                sourcePaths: [],
                sourceGenerations: {},
                warnings: [],
              },
            }
          : {}),
        controlPlaneUpdateSentinelMeta: null,
        preUpdatePluginInstallRecords: {},
        startedAt: Date.now(),
        packageUpdateNodeRunner: process.execPath,
        updateStepTimeoutMs: 90_000,
      },
      [],
    );
  let continuedResult: Awaited<ReturnType<typeof continueUpdate>> | undefined;
  const operation = diagnostics
    ? continueUpdate()
    : withUpdateCommandTerminalResult(
        async (registerRun) => {
          registerRun(run);
          continuedResult = await continueUpdate();
          if (continuedResult.preparedFailure) {
            throw continuedResult.preparedFailure;
          }
          return continuedResult;
        },
        { json: true, onResult },
      );
  const settled = await operation.catch((error: unknown) => error);
  if (diagnostics) {
    expect(observedProgress).toEqual(expectedProgress);
    expect(Buffer.concat(stderrChunks)).toEqual(Buffer.concat([expectedProgress, cancellation]));
    expect(settled).toBeInstanceOf(Error);
    expect(stdout).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    await expect(fs.access(transaction.backupRoot)).resolves.toBeUndefined();
    return;
  }
  if (completion) {
    expect.soft(stdoutAtCompletion).toBe(0);
    expect.soft(observedAtCompletion).toBe(0);
    expect.soft(readCandidateRow()).toEqual(candidateRow);
    expect.soft(candidateRow).toMatchObject({ status: "succeeded", reason: "updated" });
    expect.soft(oldRuntimeOpens).toEqual([]);
    expect(rollback).not.toHaveBeenCalled();
    if (completion === "failure") {
      expect.soft(settled).toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
      expect.soft(settled).toMatchObject({
        cause: expect.objectContaining({
          result: expect.objectContaining({ reason: "package-backup-retention-failed" }),
        }),
      });
      expect.soft(stdout).not.toHaveBeenCalled();
      expect(onResult).not.toHaveBeenCalled();
      await expect(fs.access(transaction.backupRoot)).resolves.toBeUndefined();
    } else {
      expect(settled).toMatchObject({ exitCode: 0, result: { status: "ok" } });
      expect(stdout).toHaveBeenCalledExactlyOnceWith("candidate finalization result\n");
      expect(onResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "ok" }));
    }
    return;
  }
  if (exitCode !== 0 && !handback) {
    expect(settled).toBeInstanceOf(UpdateCommandFailure);
    expect(settled).not.toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
  } else {
    expect(settled).toBe(continuedResult);
  }
  const outcome = continuedResult!;
  expect(outcome).toMatchObject({
    exitCode,
    result: { status },
  });
  expect(outcome.result.reason).toBe(reason);
  expect(outcome.candidateStartAttempted).toBe(candidateStartAttempted);
  expect(outcome.databaseRollbackAvailable).toBe(handback ? true : undefined);
  if (handback) {
    expect(stdout).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  } else {
    expect(stdout).toHaveBeenCalledExactlyOnceWith("candidate finalization result\n");
    expect(onResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status }));
  }
  if (pending || handback) {
    expect(complete).not.toHaveBeenCalled();
  } else {
    expect(complete).toHaveBeenCalledExactlyOnceWith(
      { activationVerified: false },
      expect.any(Function),
    );
  }
  expect(rollback).not.toHaveBeenCalled();
  if (windows) {
    expect(windowsRecovery.complete).toHaveBeenCalledWith(pending || recovered);
    expect(windowsRecovery.complete).not.toHaveBeenCalledWith(!(pending || recovered));
  } else {
    expect(windowsRecovery.complete).not.toHaveBeenCalled();
  }
  await expect(
    fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8"),
  ).resolves.toContain('"version":"1.0.0"');
  await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
    '"version":"2.0.0"',
  );
  if (handback) {
    await expect(transaction.rollback(() => {})).resolves.toMatchObject({ exitCode: 0 });
    await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
      '"version":"1.0.0"',
    );
  }
}
