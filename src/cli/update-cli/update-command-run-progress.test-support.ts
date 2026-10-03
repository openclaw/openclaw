import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { GatewayStateOwnerContentionError } from "../../infra/gateway-state-owner.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateErrorFact } from "../../infra/update-failure-facts.js";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import * as updateRunLedger from "../../infra/update-run-ledger.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import * as stepWrites from "../../infra/update-run-write.async.js";
import { runStep } from "../../infra/update-runner-command.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createUpdateProgress } from "./progress.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { createUpdateRunProgress } from "./update-command-run.js";

type ProgressDirectories = Pick<ReturnType<typeof useAutoCleanupTempDirTracker>, "make">;

async function withProgressRun(
  dirs: ProgressDirectories,
  exercise: (
    run: Parameters<typeof createUpdateRunProgress>[0],
    guards: ReturnType<typeof createUpdateCommandExecutionGuards>,
    root: string,
  ) => Promise<void>,
) {
  const root = dirs.make("update-progress-receipt-");
  const env = { OPENCLAW_STATE_DIR: path.join(root, "profile") };
  const control = path.join(root, "control");
  fs.mkdirSync(control);
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
  const guards = createUpdateCommandExecutionGuards({ run }, root);
  try {
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      guards.admitExecutor(await executor.enter(root));
      await exercise(run, guards, root);
    });
  } finally {
    await closeStateDatabaseForTest();
  }
}

function observeHostLedgerWrites() {
  const writes: string[] = [];
  const observe = (sql: string) => {
    if (/\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+["`]?update_runs\b/i.test(sql)) {
      writes.push(sql);
    }
  };
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql) {
    observe(sql);
    return prepare.call(this, sql);
  };
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql) {
    observe(sql);
    return exec.call(this, sql);
  };
  return {
    writes,
    restore: () => {
      prepare.mockRestore();
      exec.mockRestore();
    },
  };
}

export function registerUpdateRunReceiptTests(dirs: ProgressDirectories) {
  it.each(["retained", "replaced"] as const)(
    "awaits committed steps before commands and display with %s custody",
    async (custody) => {
      await withProgressRun(dirs, async (run, guards, root) => {
        const originalRunId = run.runId;
        const { env } = run;
        const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
        const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
        let presentation: ReturnType<typeof createUpdateProgress> | undefined;
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
        try {
          presentation = createUpdateProgress(true, run);
          const progress = createUpdateRunProgress(run, presentation.progress, guards.recordStep);
          updateRunLedger.recordUpdateRunPhase(run.runId, "validating", {}, { env });
          const entered = createDeferredCore();
          const release = createDeferredCore();
          const writeStep = stepWrites.recordUpdateRunStepAsync;
          const writer = vi
            .spyOn(stepWrites, "recordUpdateRunStepAsync")
            .mockImplementation(async (...args) => {
              const committed = await writeStep(...args);
              if (args[1].step === "fetch" && args[1].status === "in_progress") {
                entered.resolve();
                await release.promise;
              }
              return committed;
            });
          const host = observeHostLedgerWrites();
          const reread = vi.spyOn(updateRunLedger, "getUpdateRun").mockImplementation(() => {
            throw new Error("step presentation must use its committed row");
          });
          const runCommand = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
          const pending = runStep({
            name: "fetch",
            argv: ["run", "fetch"],
            cwd: root,
            stepIndex: 0,
            totalSteps: 3,
            progress,
            runCommand,
          });
          try {
            await Promise.race([
              entered.promise,
              pending.then(() => {
                throw new Error(
                  `Command finished without its worker receipt; host ledger writes: ${host.writes.length}`,
                );
              }),
            ]);
            expect(runCommand).not.toHaveBeenCalled();
            expect(log).not.toHaveBeenCalledWith("validating — fetch...");
            expect(
              (await updateRunLedger.getUpdateRunAsync(run.runId, { env }))?.steps,
            ).toContainEqual(expect.objectContaining({ step: "fetch", status: "in_progress" }));
            if (custody === "replaced") {
              run.runId = `${originalRunId}-replaced`;
            }
            release.resolve();
            if (custody === "replaced") {
              const failure = await pending.then(
                () => undefined,
                (error: unknown) => error,
              );
              expect(collectNestedErrorCandidates(failure)).toContainEqual(
                expect.any(UpdateRequesterRevokedError),
              );
              expect(runCommand).not.toHaveBeenCalled();
              expect(log).not.toHaveBeenCalledWith("validating — fetch...");
              expect(host.writes).toEqual([]);
              return;
            }
            await expect(pending).resolves.toMatchObject({ name: "fetch", exitCode: 0 });
            expect(runCommand).toHaveBeenCalledOnce();
            for (const [index, name] of ["build", "doctor"].entries()) {
              const step = { name, command: `run ${name}`, index: index + 1, total: 3 };
              await progress.onStepStart?.(step);
              await progress.onStepComplete?.({
                ...step,
                durationMs: 1,
                exitCode: 1,
                ...(name === "build" ? { stdoutTail: "Build type error" } : {}),
                ...(name === "doctor"
                  ? {
                      advisory: {
                        kind: "package-post-install-doctor" as const,
                        message: "Skipped optional cache cleanup",
                      },
                      warnings: ["Skipped optional cache cleanup", "Skipped legacy cache cleanup"],
                    }
                  : {}),
              });
            }
            expect(log).toHaveBeenCalledWith("validating — fetch...");
            expect(log).toHaveBeenCalledWith("validating — build...");
            expect(log.mock.calls.flat().join("\n")).toContain("Build type error");
            expect(log.mock.calls.flat().join("\n")).toContain("Skipped optional cache cleanup");
            expect(
              log.mock.calls
                .flat()
                .filter((line) => typeof line === "string" && line.startsWith("Phase:")),
            ).toEqual(["Phase: requested", "Phase: validating"]);
            expect(host.writes).toEqual([]);
          } finally {
            release.resolve();
            await pending.catch(() => undefined);
            run.runId = originalRunId;
            writer.mockRestore();
            host.restore();
            reread.mockRestore();
          }
          const recorded = getUpdateRun(run.runId, { env });
          expect(
            recorded?.steps
              .filter((step) => step.step === "fetch" || step.step === "build")
              .map(({ step, status, detail }) => ({ step, status, detail })),
          ).toEqual([
            { step: "fetch", status: "completed", detail: undefined },
            { step: "build", status: "failed", detail: "Exit code: 1; Build type error" },
          ]);
          expect(recorded?.steps).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ step: "doctor", status: "completed" }),
              expect.objectContaining({
                step: "warning:doctor",
                status: "completed",
                detail: "Skipped optional cache cleanup",
              }),
              expect.objectContaining({
                step: "warning:doctor:2",
                status: "completed",
                detail: "Skipped legacy cache cleanup",
              }),
            ]),
          );
        } finally {
          try {
            presentation?.dispose();
          } finally {
            if (tty) {
              Object.defineProperty(process.stdout, "isTTY", tty);
            } else {
              Reflect.deleteProperty(process.stdout, "isTTY");
            }
          }
        }
      });
    },
  );
}

export function registerUpdateRunReceiptFailureTests(dirs: ProgressDirectories) {
  it.each([
    "in_progress",
    "completed",
    "command-cleanup",
    "nonzero-with-results",
    "nonzero-without-results",
  ] as const)(
    "identifies a progress ledger failure without losing the command outcome (%s)",
    async (outcome) => {
      await withProgressRun(dirs, async (run, guards, root) => {
        const nonzero = outcome === "nonzero-with-results" || outcome === "nonzero-without-results";
        const status = outcome === "command-cleanup" || nonzero ? "failed" : outcome;
        const commandStderr = "fixture candidate checkout refused";
        const cause = new GatewayStateOwnerContentionError("/synthetic/openclaw.sqlite");
        const commandFailure = new CommandProcessCleanupError({
          cause: new Error("command tree still alive"),
        });
        const writeStep = stepWrites.recordUpdateRunStepAsync;
        let receiptAttempted = false;
        const writer = vi
          .spyOn(stepWrites, "recordUpdateRunStepAsync")
          .mockImplementation(async (...args) => {
            const committed = await writeStep(...args);
            if (args[1].step === "preflight worktree" && args[1].status === status) {
              receiptAttempted = true;
              throw cause;
            }
            return committed;
          });
        const display = { onStepStart: vi.fn(), onStepComplete: vi.fn() };
        const progress = createUpdateRunProgress(run, display, guards.recordStep);
        const results: UpdateStepResult[] = [];
        const runCommand = vi.fn(async () => {
          if (outcome === "command-cleanup") {
            throw commandFailure;
          }
          return {
            code: nonzero ? 17 : 0,
            stdout: "command completed",
            stderr: nonzero ? commandStderr : "",
          };
        });
        const host = observeHostLedgerWrites();
        try {
          const observed = await runStep({
            name: "preflight worktree",
            argv: ["git", "worktree", "add"],
            cwd: root,
            stepIndex: 1,
            totalSteps: 3,
            progress,
            runCommand,
            ...(outcome === "nonzero-without-results" ? {} : { results }),
          }).then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(receiptAttempted).toBe(true);
          const errors = collectNestedErrorCandidates(observed);
          expect(errors).toContain(cause);
          expect(errors).toContainEqual(
            expect.objectContaining({
              message: `Could not record update step "preflight worktree" (${status}): ${cause.message}`,
              cause,
            }),
          );
          expect(hasCommandProcessCleanupError(observed)).toBe(outcome === "command-cleanup");
          if (outcome === "command-cleanup") {
            expect(errors).toContain(commandFailure);
          }
          if (nonzero) {
            expect(errors).toContainEqual(
              expect.objectContaining({
                exitCode: 17,
                stderrTail: commandStderr,
                failureFacts: [
                  expect.objectContaining({
                    check: "preflight worktree",
                    code: "command-failed",
                    message: commandStderr,
                  }),
                ],
              }),
            );
            const rendered = createUpdateErrorFact("update", observed, run.env);
            expect(rendered.message).toContain("Exit code: 17");
            expect(rendered.message).toContain(commandStderr);
          }
          if (outcome === "in_progress") {
            expect(runCommand).not.toHaveBeenCalled();
            expect(results).toEqual([]);
            expect(display.onStepStart).not.toHaveBeenCalled();
          } else {
            expect(runCommand).toHaveBeenCalledOnce();
            if (outcome === "nonzero-without-results") {
              expect(results).toEqual([]);
            } else {
              expect(results).toEqual([
                expect.objectContaining({
                  name: "preflight worktree",
                  exitCode: nonzero ? 17 : outcome === "command-cleanup" ? 1 : 0,
                }),
              ]);
            }
            expect(display.onStepStart).toHaveBeenCalledOnce();
          }
          expect(display.onStepComplete).not.toHaveBeenCalled();
          expect(host.writes).toEqual([]);
        } finally {
          writer.mockRestore();
          host.restore();
        }
      });
    },
  );
}
