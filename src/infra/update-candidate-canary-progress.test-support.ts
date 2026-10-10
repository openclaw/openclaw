import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi, type Mock } from "vitest";
import type { UpdateCommandOptions } from "../cli/update-cli/shared.js";
import { validateUpdateCandidateWithProgress } from "../cli/update-cli/update-command-candidate-validation.js";
import { createUpdateCommandExecutionGuards } from "../cli/update-cli/update-command-execution-guards.js";
import * as bundledDirectory from "../plugins/bundled-dir.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { collectNestedErrorCandidates } from "./error-graph-internal.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import { stubHealthyGateway } from "./update-candidate-canary.test-support.js";
import * as candidateIo from "./update-candidate-io.js";
import { UpdateRequesterRevokedError } from "./update-requester-authority.js";
import { createUpdateRun, getUpdateRunAsync } from "./update-run-ledger.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

type CanaryProgressMocks = { spawn: Mock; snapshot: Mock };

async function readSqliteSidecarIdentities(databasePath: string) {
  return Promise.all(
    ["-wal", "-shm"].map(async (suffix) => {
      const { dev, ino, birthtimeNs } = await fs.stat(`${databasePath}${suffix}`, { bigint: true });
      return { dev, ino, birthtimeNs };
    }),
  );
}

export function registerCanaryProgressWorkerTests(
  getRoot: () => string,
  mocks: CanaryProgressMocks,
  admission: { active: boolean; beforeGrant?: (stage: string) => void },
) {
  it.each([
    "recorded",
    "recorded-text",
    "reopened",
    "source-replaced",
    "revoked-at-commit",
    "interrupted-after-acceptance",
    "uncertain",
  ] as const)(
    "persists streamed candidate progress through its admitted worker (%s)",
    async (outcome) => {
      const root = getRoot();
      stubHealthyGateway();
      const sourcePackageRoot = path.join(root, "serving-runtime");
      const sourceBundle = path.join(sourcePackageRoot, "dist", "extensions");
      vi.spyOn(bundledDirectory, "resolveBundledPluginsDir").mockReturnValue(sourceBundle);
      const json = outcome !== "recorded-text";
      const stdout = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      const stderr = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const announcements: unknown[] = [];
      const spawn = mocks.spawn.getMockImplementation()!;
      mocks.spawn.mockImplementation((...args) => {
        announcements.push((json ? stderr : stdout).mock.calls.at(-1)?.[0]);
        return spawn(...args);
      });
      let beforeInventory: Awaited<ReturnType<typeof readSqliteSidecarIdentities>> | undefined;
      let pressurePublished = false;
      const snapshot = mocks.snapshot.getMockImplementation()!;
      mocks.snapshot.mockImplementation(
        async (
          command,
          options: {
            input: string;
            onOutputChunk?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
          },
        ) => {
          const request: unknown = JSON.parse(options.input);
          if (isRecord(request) && request.mode === "inventory") {
            expect(request.sourceBundledPlugins).toEqual({
              packageRoot: sourcePackageRoot,
              directory: sourceBundle,
            });
          }
          if (outcome === "reopened" && isRecord(request) && request.mode === "inventory") {
            beforeInventory = await readSqliteSidecarIdentities(
              writeOptions.context.admission.databasePath,
            );
          }
          if (isRecord(request) && request.mode === "snapshot") {
            if (outcome === "reopened") {
              expect(beforeInventory).toBeDefined();
              const pressure = channel("openclaw.memory.critical");
              expect(pressure.hasSubscribers).toBe(true);
              // Retirement removes idle actors synchronously; following writes join their cleanup.
              pressure.publish({});
              pressurePublished = true;
            }
            for (const status of ["copying", "completed"]) {
              const frame = Buffer.from(
                `State schema progress: ${JSON.stringify({
                  phase: "database snapshot",
                  path: path.join(root, "state", "openclaw.sqlite"),
                  snapshot: {
                    status,
                    copiedPages: status === "copying" ? 460222 : 920445,
                    totalPages: 920445,
                    ...(status === "completed" ? { copiedBytes: 3770142720 } : {}),
                    elapsedMs: 2500,
                  },
                })}\n`,
              );
              // Process chunks may split the protocol prefix or a JSON value.
              options.onOutputChunk?.(frame.subarray(0, 13), "stderr");
              options.onOutputChunk?.(frame.subarray(13), "stderr");
            }
          }
          return snapshot(command, options);
        },
      );
      const env = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "source-state") };
      const created = createUpdateRun({ trigger: "cli" }, { env });
      if (outcome === "reopened") {
        await closeStateDatabaseForTest();
      }
      const run: NonNullable<UpdateCommandOptions["run"]> = { runId: created.runId, env };
      const opts = { run };
      const guards = createUpdateCommandExecutionGuards(opts, root);
      const writeOptions = guards.captureWriteOptions();
      if (outcome === "source-replaced") {
        await closeStateDatabaseForTest();
        const source = writeOptions.context.admission.databasePath;
        await fs.rename(source, `${source}.original`);
        await fs.copyFile(`${source}.original`, source);
      }
      const hostWrites: string[] = [];
      const admissionSql: string[] = [];
      const observeSql = (sql: string) => {
        if (/\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+["`]?update_runs\b/i.test(sql)) {
          hostWrites.push(sql);
        }
        if (admission.active) {
          admissionSql.push(sql);
        }
      };
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql) {
        observeSql(sql);
        return prepare.call(this, sql);
      };
      DatabaseSync.prototype.exec = function (this: DatabaseSync, sql) {
        observeSql(sql);
        return exec.call(this, sql);
      };
      const unknown = new SqliteWorkerError(
        "receipt acknowledgement unavailable",
        "outcome-unknown",
      );
      const runWorker = stateWorker.runOpenClawStateWorkerOperation;
      const worker = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
      if (outcome === "uncertain") {
        worker.mockImplementationOnce(runWorker).mockRejectedValueOnce(unknown);
      }
      let checkedCommit = false;
      let commits = 0;
      admission.beforeGrant = (stage) => {
        if (stage === "commit") {
          // Initial admission warms the writer before streamed snapshot receipts.
          if (++commits === 1) {
            return;
          }
          const firstCommit = !checkedCommit;
          checkedCommit = true;
          if (outcome === "interrupted-after-acceptance" && firstCommit) {
            run.interrupted = true;
          }
          if (outcome === "revoked-at-commit") {
            opts.run = { ...run };
          }
        }
      };
      const onStepComplete = vi.fn();
      const pending = Promise.resolve().then(() =>
        validateUpdateCandidateWithProgress(
          {
            root,
            sourcePackageRoot,
            config: {},
            env,
            assertCurrent: guards.assertCurrent,
            writeOptions,
          },
          { opts: { json }, progress: { onStepComplete } },
          run,
        ),
      );
      try {
        if (outcome === "source-replaced") {
          await expect(pending).rejects.toThrow();
          expect(worker).not.toHaveBeenCalled();
          expect(mocks.spawn).not.toHaveBeenCalled();
          expect(await getUpdateRunAsync(run.runId, { env })).toEqual(created);
          return;
        }
        if (outcome === "uncertain") {
          const failure = await pending.then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(hasCommandProcessCleanupError(failure)).toBe(true);
          expect(collectNestedErrorCandidates(failure)).toContain(unknown);
          expect(mocks.spawn).not.toHaveBeenCalled();
          return;
        }
        if (outcome === "revoked-at-commit" || outcome === "interrupted-after-acceptance") {
          await expect(pending).rejects.toBeInstanceOf(UpdateRequesterRevokedError);
          expect(checkedCommit).toBe(true);
          const saved = await getUpdateRunAsync(run.runId, { env });
          if (outcome === "revoked-at-commit") {
            expect(saved).toEqual({
              ...created,
              updatedAtMs: expect.any(Number),
              steps: [
                ...created.steps,
                {
                  step: "candidate-state-snapshot",
                  status: "in_progress",
                  startedAtMs: expect.any(Number),
                  detail: "Preparing update checks",
                },
              ],
            });
          } else {
            expect(saved?.steps).toContainEqual(
              expect.objectContaining({
                step: "candidate-state-snapshot",
                status: "in_progress",
                detail: expect.stringContaining("completed, attempt 1, 920445/920445 pages"),
              }),
            );
          }
          expect(onStepComplete).toHaveBeenCalledWith(
            expect.objectContaining({
              name: "candidate-state-snapshot",
              exitCode: 1,
              failureFacts: expect.arrayContaining([
                expect.objectContaining({
                  message: expect.stringContaining("requester-revoked"),
                }),
              ]),
            }),
          );
          expect(mocks.spawn).not.toHaveBeenCalled();
          return;
        }
        const result = await pending;
        if (outcome === "reopened") {
          expect(pressurePublished).toBe(true);
          expect(
            await readSqliteSidecarIdentities(writeOptions.context.admission.databasePath),
          ).toEqual(beforeInventory);
        }
        expect(checkedCommit).toBe(true);
        const saved = await getUpdateRunAsync(run.runId, { env });
        expect(result.status).toBe("ok");
        const checks = [
          "candidate-doctor",
          "candidate-doctor-lint",
          "candidate-config",
          "candidate-plugins",
          "candidate-recovery",
          "candidate-gateway-startup",
        ];
        expect(announcements).toEqual(
          checks.map((name) => expect.stringMatching(new RegExp(`^${name}: \\S`))),
        );
        expect(json ? stdout : stderr).not.toHaveBeenCalled();
        for (const step of checks) {
          expect(saved?.steps).toContainEqual(
            expect.objectContaining({ step, status: "in_progress" }),
          );
        }
        expect(saved?.steps).toContainEqual(
          expect.objectContaining({
            step: "candidate-state-snapshot",
            status: "in_progress",
            detail: expect.stringContaining("completed, attempt 1, 920445/920445 pages"),
          }),
        );
        expect(saved?.steps).toContainEqual(
          expect.objectContaining({ step: "candidate-state-cleanup", status: "completed" }),
        );
        expect(
          saved?.steps.find((step) => step.step === "candidate-state-snapshot")?.detail,
        ).toContain("~/state/openclaw.sqlite");
        const retained = result.steps.flatMap(updateRunStepsFromResultStep);
        expect(retained).toContainEqual(
          expect.objectContaining({
            step: "diagnostic:candidate-state-snapshot",
            status: "completed",
            detail: expect.stringContaining("3,770,142,720 bytes, 2.500 seconds"),
          }),
        );
      } finally {
        admission.beforeGrant = undefined;
        await pending.catch(() => undefined);
        prepare.mockRestore();
        exec.mockRestore();
        worker.mockRestore();
        stdout.mockRestore();
        stderr.mockRestore();
        // Effect guards still read recovery on the host; only ledger DML and worker admission are fenced here.
        expect(hostWrites).toEqual([]);
        expect(admissionSql).toEqual([]);
        if (outcome === "uncertain") {
          const request = mocks.snapshot.mock.calls.at(-1)?.[1].input;
          if (request) {
            const { targetStateDir } = JSON.parse(request) as { targetStateDir: string };
            await fs.rm(targetStateDir, { recursive: true, force: true });
          }
        }
      }
    },
  );
}

export function registerCanaryUncertainReceiptTests({
  mocks,
  canaryStateOptions,
  setRuntimeError,
}: {
  mocks: CanaryProgressMocks;
  canaryStateOptions: (timeoutMs?: number) => Parameters<typeof validateUpdateCandidateCanary>[0];
  setRuntimeError: (value: boolean) => void;
}) {
  it.each([
    "operation-failed",
    "cancelled",
    "authority-revoked",
    "earlier-progress-failed",
  ] as const)("retains snapshot uncertainty after settled IO is %s", async (ordering) => {
    const options = canaryStateOptions(3_000);
    const receipt = createDeferredCore();
    const earlierReceipt = createDeferredCore();
    const operationSettled = createDeferredCore();
    const caller = new AbortController();
    const uncertain = new CommandProcessCleanupError();
    const operationFailure = new Error("snapshot worker failed before progress settled");
    const earlierFailure = new Error("earlier snapshot progress recording failed");
    let current = true;
    let retained: string | undefined;
    let progressEmitted = false;
    const snapshot = mocks.snapshot.getMockImplementation()!;
    mocks.snapshot.mockImplementation(
      async (
        command,
        commandOptions: {
          input: string;
          onOutputChunk?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
        },
      ) => {
        const request: unknown = JSON.parse(commandOptions.input);
        if (isRecord(request) && request.mode === "snapshot") {
          if (typeof request.targetStateDir !== "string") {
            throw new Error("Snapshot fixture requires its owned target directory");
          }
          retained = request.targetStateDir;
          await fs.writeFile(path.join(retained, "pending-snapshot-copy"), "synthetic copy");
          progressEmitted = true;
          for (const status of ordering === "earlier-progress-failed"
            ? ["copying", "completed"]
            : ["copying"]) {
            commandOptions.onOutputChunk?.(
              Buffer.from(
                `State schema progress: ${JSON.stringify({
                  phase: "database snapshot",
                  path: path.join(options.stateDir, "state", "openclaw.sqlite"),
                  snapshot: {
                    status,
                    copiedPages: status === "completed" ? 2 : 1,
                    totalPages: 2,
                    elapsedMs: 1,
                  },
                })}\n`,
              ),
              "stderr",
            );
          }
          if (ordering === "operation-failed") {
            throw operationFailure;
          }
        }
        return snapshot(command, commandOptions);
      },
    );
    const runBudget = candidateIo.withUpdateCandidateIoBudget;
    const budget = vi
      .spyOn(candidateIo, "withUpdateCandidateIoBudget")
      .mockImplementation(async (...args) => {
        try {
          return await runBudget(...args);
        } finally {
          if (progressEmitted) {
            operationSettled.resolve();
          }
        }
      });
    const onStep = vi.fn();
    const onProgress = vi
      .fn((step: { step: string }) =>
        step.step === "candidate-state-snapshot" ? receipt.promise : undefined,
      )
      .mockImplementationOnce(() => undefined);
    if (ordering === "earlier-progress-failed") {
      onProgress.mockImplementationOnce(() => earlierReceipt.promise);
    }
    const pending = validateUpdateCandidateCanary({
      ...options,
      signal: caller.signal,
      assertCurrent: () => {
        if (!current) {
          throw new Error("snapshot authority revoked");
        }
      },
      onStep,
      onProgress,
    });
    const observed = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await operationSettled.promise;
      expect(onProgress).toHaveBeenCalledTimes(ordering === "earlier-progress-failed" ? 3 : 2);
      expect(onStep).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
      if (ordering === "cancelled") {
        caller.abort(new Error("cancelled after snapshot IO settled"));
      } else if (ordering === "authority-revoked") {
        current = false;
      } else if (ordering === "earlier-progress-failed") {
        earlierReceipt.reject(earlierFailure);
        await earlierReceipt.promise.catch(() => undefined);
      }
      receipt.reject(uncertain);
      const result = await observed;
      const failure = "error" in result ? result.error : undefined;
      expect(hasCommandProcessCleanupError(failure)).toBe(true);
      const errors = collectNestedErrorCandidates(failure);
      expect(errors).toContain(uncertain);
      if (ordering === "operation-failed") {
        expect(errors).toContain(operationFailure);
        expect(errors).toContainEqual(
          expect.objectContaining({
            errors: [operationFailure, uncertain],
            cause: operationFailure,
          }),
        );
      } else if (ordering === "earlier-progress-failed") {
        expect(errors).toContain(earlierFailure);
        expect(errors).toContainEqual(
          expect.objectContaining({
            errors: [earlierFailure, uncertain],
            cause: earlierFailure,
          }),
        );
      }
      expect(onStep).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(retained).toBeDefined();
      await expect(
        fs.readFile(path.join(retained!, "pending-snapshot-copy"), "utf8"),
      ).resolves.toBe("synthetic copy");
    } finally {
      earlierReceipt.resolve();
      receipt.resolve();
      await observed;
      budget.mockRestore();
      if (retained) {
        await fs.rm(retained, { recursive: true, force: true });
      }
    }
  });

  it.each(["completed-step", "failed-step"] as const)(
    "retains rehearsal artifacts when the %s write has an uncertain outcome",
    async (receipt) => {
      const uncertain = new CommandProcessCleanupError();
      setRuntimeError(receipt === "failed-step");
      const name = receipt === "completed-step" ? "candidate-state-snapshot" : "candidate-recovery";
      let injected = false;
      const onStep = vi.fn(async (step: { name: string }) => {
        if (!injected && step.name === name) {
          injected = true;
          throw uncertain;
        }
      });
      try {
        await expect(
          validateUpdateCandidateCanary({ ...canaryStateOptions(3_000), onStep }),
        ).rejects.toBe(uncertain);
        expect(injected).toBe(true);
        expect(onStep).toHaveBeenLastCalledWith(
          expect.objectContaining({ name, exitCode: receipt === "completed-step" ? 0 : 1 }),
        );
        expect(onStep.mock.calls.some(([step]) => step.name.endsWith("-cleanup"))).toBe(false);
        if (receipt === "completed-step") {
          expect(mocks.spawn).not.toHaveBeenCalled();
        }
        const request = JSON.parse(mocks.snapshot.mock.calls.at(-1)![1].input) as {
          targetStateDir: string;
        };
        expect((await fs.stat(request.targetStateDir)).isDirectory()).toBe(true);
        await expect(
          fs.access(path.join(request.targetStateDir, "openclaw.json")),
        ).resolves.toBeUndefined();
      } finally {
        const request = mocks.snapshot.mock.calls.at(-1)?.[1].input;
        if (request) {
          const { targetStateDir } = JSON.parse(request) as { targetStateDir: string };
          await fs.rm(targetStateDir, { recursive: true, force: true });
        }
      }
    },
  );

  it("joins an uncertain cleanup progress receipt before retiring rehearsal artifacts", async () => {
    stubHealthyGateway();
    const entered = createDeferredCore();
    const receipt = createDeferredCore();
    const uncertain = new CommandProcessCleanupError();
    const remove = vi.spyOn(fs, "rm");
    const pending = validateUpdateCandidateCanary({
      ...canaryStateOptions(3_000),
      onProgress: (step) => {
        if (step.step === "candidate-state-cleanup" && step.status === "in_progress") {
          entered.resolve();
          return receipt.promise;
        }
        return undefined;
      },
    });
    const rejected = expect(pending).rejects.toBe(uncertain);
    let targetStateDir: string | undefined;
    try {
      await entered.promise;
      ({ targetStateDir } = JSON.parse(mocks.snapshot.mock.calls.at(-1)![1].input) as {
        targetStateDir: string;
      });
      expect(remove.mock.calls.some(([target]) => target === targetStateDir)).toBe(false);
      await expect(fs.access(targetStateDir)).resolves.toBeUndefined();
      receipt.reject(uncertain);
      await rejected;
      expect(remove.mock.calls.some(([target]) => target === targetStateDir)).toBe(false);
      await expect(fs.access(targetStateDir)).resolves.toBeUndefined();
    } finally {
      receipt.reject(uncertain);
      await pending.catch(() => undefined);
      remove.mockRestore();
      if (targetStateDir) {
        await fs.rm(targetStateDir, { recursive: true, force: true });
      }
    }
  });
}
