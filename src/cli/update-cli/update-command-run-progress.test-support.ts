import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import type { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withTriageTerminal } from "../../commands/triage.test-support.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { GatewayStateOwnerContentionError } from "../../infra/gateway-state-owner.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateErrorFact } from "../../infra/update-failure-facts.js";
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
  const calls = (["prepare", "exec"] as const).map((method) =>
    vi.spyOn(DatabaseSync.prototype, method),
  );
  return {
    get writes() {
      return calls
        .flatMap((call) => call.mock.calls.map(([sql]) => sql))
        .filter((sql) =>
          /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+["`]?update_runs\b/i.test(sql),
        );
    },
    restore: () => calls.forEach((call) => call.mockRestore()),
  };
}

export function registerUpdateRunReceiptTests(dirs: ProgressDirectories) {
  it("awaits committed steps before commands and display", async () => {
    await withProgressRun(dirs, (run, guards, root) =>
      withTriageTerminal(false, async () => {
        const { env } = run;
        const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
        const presentation = createUpdateProgress(true, run);
        try {
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
            await awaitGateBeforeSettlement(
              entered.promise,
              pending,
              "Command finished without its worker receipt",
            );
            expect(runCommand).not.toHaveBeenCalled();
            expect(log).not.toHaveBeenCalledWith("validating — fetch...");
            expect(
              (await updateRunLedger.getUpdateRunAsync(run.runId, { env }))?.steps,
            ).toContainEqual(expect.objectContaining({ step: "fetch", status: "in_progress" }));
            release.resolve();
            await expect(pending).resolves.toMatchObject({ name: "fetch", exitCode: 0 });
            expect(runCommand).toHaveBeenCalledOnce();
            for (const [index, result] of [
              { name: "build", stdoutTail: "Build type error" },
              {
                name: "doctor",
                advisory: {
                  kind: "package-post-install-doctor" as const,
                  message: "Skipped optional cache cleanup",
                },
                warnings: ["Skipped optional cache cleanup", "Skipped legacy cache cleanup"],
              },
            ].entries()) {
              const { name } = result;
              const step = { name, command: `run ${name}`, index: index + 1, total: 3 };
              await progress.onStepStart?.(step);
              await progress.onStepComplete?.({ ...step, ...result, durationMs: 1, exitCode: 1 });
            }
            expect(log.mock.calls).toEqual(
              expect.arrayContaining([["validating — fetch..."], ["validating — build..."]]),
            );
            const output = log.mock.calls.flat();
            expect(output.join("\n")).toContain("Build type error");
            expect(output.join("\n")).toContain("Skipped optional cache cleanup");
            expect(
              output.filter((line) => typeof line === "string" && line.startsWith("Phase:")),
            ).toEqual(["Phase: requested", "Phase: validating"]);
            expect(host.writes).toEqual([]);
          } finally {
            release.resolve();
            await pending.catch(() => undefined);
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
            expect.arrayContaining(
              [
                { step: "doctor" },
                { step: "warning:doctor", detail: "Skipped optional cache cleanup" },
                { step: "warning:doctor:2", detail: "Skipped legacy cache cleanup" },
              ].map((step) => expect.objectContaining({ ...step, status: "completed" })),
            ),
          );
        } finally {
          presentation.dispose();
        }
      }),
    );
  });
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
          const errors = collectNestedErrorCandidates(observed);
          expect(errors).toContain(cause);
          expect(errors).toContainEqual(
            expect.objectContaining({
              message: `Could not record update step "preflight worktree" (${status}): ${cause.message}`,
              cause,
            }),
          );
          expect(receiptAttempted).toBe(true);
          expect(hasCommandProcessCleanupError(observed)).toBe(outcome === "command-cleanup");
          expect(host.writes).toEqual([]);
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
            const { message } = createUpdateErrorFact("update", observed, run.env);
            expect(message).toContain("Exit code: 17");
            expect(message).toContain(commandStderr);
          }
          const calls = outcome === "in_progress" ? 0 : 1;
          expect(runCommand).toHaveBeenCalledTimes(calls);
          expect(display.onStepStart).toHaveBeenCalledTimes(calls);
          expect(results).toEqual(
            outcome === "in_progress" || outcome === "nonzero-without-results"
              ? []
              : [
                  expect.objectContaining({
                    name: "preflight worktree",
                    exitCode: nonzero ? 17 : outcome === "command-cleanup" ? 1 : 0,
                  }),
                ],
          );
          expect(display.onStepComplete).not.toHaveBeenCalled();
        } finally {
          writer.mockRestore();
          host.restore();
        }
      });
    },
  );
}
