import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { holdForeignWriter } from "../../infra/sqlite-worker-shared-state-admission.test-support.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRunAsync,
} from "../../infra/update-run-ledger.js";
import * as phaseWrites from "../../infra/update-run-write.async.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import type { UpdateCommandOptions } from "./shared.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { bindExecutionGuards } from "./update-command-execution.test-support.js";
import type * as fixtures from "./update-command-execution.test-support.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import * as gitAdmission from "./update-command-git-admission.js";
import type { updateGitInstall } from "./update-command-git.js";
import type { PackageInstallUpdateParams } from "./update-command-package.js";

type Phase = "validating" | "activating" | "staging";
type FixtureInputs = Pick<typeof fixtures, "executionParams" | "mocks" | "successfulUpdate"> & {
  phaseAdmission: { active: boolean };
};
type Run = NonNullable<UpdateCommandOptions["run"]>;

export function registerExecutionPhaseReceiptTests(inputs: FixtureInputs) {
  const { executionParams, mocks, successfulUpdate, phaseAdmission } = inputs;
  const withPhase = async (
    phase: Phase,
    exercise: (fixture: {
      root: string;
      run: Run;
      params: Omit<Parameters<typeof executeMutableUpdate>[0], "executionGuards">;
      events: string[];
      beforeCall: { run?: () => void };
      start: () => ReturnType<typeof executeMutableUpdate>;
    }) => Promise<void>,
  ) => {
    await withTestDir({ prefix: "update-phase-receipts-" }, async (root) => {
      const state = path.join(root, "state");
      const control = path.join(root, "coordinator");
      await fs.mkdir(state, { mode: 0o700 });
      await fs.mkdir(control, { mode: 0o700 });
      await fs.writeFile(path.join(state, "openclaw.json"), "{}");
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.2" }),
      );
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      const env = { OPENCLAW_STATE_DIR: state };
      const run: Run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      try {
        await phaseWrites.recordUpdateRunStepAsync(
          run.runId,
          { step: "fixture-warm", status: "completed" },
          { env },
        );
        const events: string[] = [];
        const beforeCall: { run?: () => void } = {};
        const params = {
          ...executionParams(phase === "staging" ? "git" : "package"),
          root,
          shouldRestart: false,
          opts: { json: true, restart: false, run },
          onActivation: () => {
            events.push("activated");
          },
        };
        mocks.maybeStopService.mockImplementation(async ({ phase: servicePhase }) => {
          if (phase === "activating" && servicePhase === "prepare") {
            events.push("service-prepare");
          }
          return {
            inspected: true,
            runtimeInspected: true,
            running: false,
            stopped: false,
            serviceEnv: env,
            serviceUpdateVerdict: { kind: "absent" },
          };
        });
        mocks.validateCanary.mockImplementation(async () => {
          if (phase === "validating") {
            events.push("canary");
          }
          return { status: "ok", phase: "readiness", steps: [], durationMs: 1, logTail: [] };
        });
        mocks.runPackageUpdate.mockImplementation(async (options: PackageInstallUpdateParams) => {
          if (phase === "validating") {
            beforeCall.run?.();
            await options.validateCandidate(root);
          } else {
            await options.validateCandidate(root);
            beforeCall.run?.();
            await options.beforeActivate();
          }
          return { ...successfulUpdate, root };
        });
        mocks.runGitUpdate.mockImplementation(
          async (options: Parameters<typeof updateGitInstall>[0]) => {
            beforeCall.run?.();
            await options.inspectGitTarget({ sha: "a".repeat(40), version: "2026.9.2" });
            events.push("inspected");
            return { ...successfulUpdate, mode: "git", root };
          },
        );
        await withUpdateCommandExecutor(run.runId, async (executor) => {
          mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
            admitExecutor(await executor.enter(root));
            if (phase === "staging") {
              events.push("prepared");
            }
          });
          await exercise({
            root,
            run,
            params,
            events,
            beforeCall,
            start: async () => executeMutableUpdate(await bindExecutionGuards(params)),
          });
        });
      } finally {
        await run.sourceArtifactLock?.release();
        await closeStateDatabaseForTest();
      }
    });
  };

  it.each(["validating", "activating", "staging"] as const)(
    "awaits the real %s phase acknowledgement without host ledger DML",
    async (phase) =>
      withPhase(phase, async (fixture) => {
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const original = phaseWrites.recordUpdateRunPhaseAsync;
        const phaseWrite = vi
          .spyOn(phaseWrites, "recordUpdateRunPhaseAsync")
          .mockImplementation(async (...args) => {
            const record = await original(...args);
            if (args[1] === phase) {
              entered.resolve();
              await release.promise;
            }
            return record;
          });
        let observing = false;
        fixture.beforeCall.run = () => {
          observing = true;
        };
        const hostWrites: string[] = [];
        const admissionSql: string[] = [];
        const observe = (sql: string) => {
          if (
            observing &&
            /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+["`]?update_runs\b/i.test(sql)
          ) {
            hostWrites.push(sql);
          }
          if (
            observing &&
            phaseAdmission.active &&
            /\b(?:update_runs|config_machine_state)\b/i.test(sql)
          ) {
            admissionSql.push(sql);
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
        const pending = fixture.start();
        try {
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error(
                `Phase callback finished without its worker receipt; host ledger writes: ${hostWrites.length}`,
              );
            }),
          ]);
          expect(fixture.events).toEqual([]);
          const recorded = await getUpdateRunAsync(fixture.run.runId, { env: fixture.run.env });
          expect(recorded?.phase).toBe(phase);
          if (phase === "staging") {
            expect(recorded?.target).toMatchObject({
              kind: "git",
              sha: "a".repeat(40),
              version: "2026.9.2",
            });
          }
          release.resolve();
          expect(await pending).toMatchObject({ result: { status: "ok" } });
          expect(fixture.events).toContain(
            phase === "validating" ? "canary" : phase === "activating" ? "activated" : "prepared",
          );
          expect(hostWrites).toEqual([]);
          expect(admissionSql).toEqual([]);
        } finally {
          release.resolve();
          await pending.catch(() => undefined);
          phaseWrite.mockRestore();
          prepare.mockRestore();
          exec.mockRestore();
        }
      }),
  );

  it("lets the host release a native writer during the actual validating phase", async () => {
    await withPhase("validating", async (fixture) => {
      const context = captureOpenClawStateWorkerContext({ env: fixture.run.env });
      let foreign: ReturnType<typeof holdForeignWriter> | undefined;
      let releaseTurn: ReturnType<typeof setImmediate> | undefined;
      let phaseSettled = false;
      let releasedBeforeSettlement = false;
      const original = mocks.runPackageUpdate.getMockImplementation()!;
      mocks.runPackageUpdate.mockImplementation(async (options: PackageInstallUpdateParams) => {
        const callback = options.validateCandidate;
        return original({
          ...options,
          validateCandidate: async (
            ...args: Parameters<PackageInstallUpdateParams["validateCandidate"]>
          ) => {
            try {
              return await callback(...args);
            } finally {
              phaseSettled = true;
            }
          },
        });
      });
      fixture.beforeCall.run = () => {
        foreign = holdForeignWriter(context);
        releaseTurn = setImmediate(() => {
          releasedBeforeSettlement = !phaseSettled;
          foreign?.release();
        });
      };
      try {
        expect(await fixture.start()).toMatchObject({ result: { status: "ok" } });
        expect(releasedBeforeSettlement).toBe(true);
        expect((await getUpdateRunAsync(fixture.run.runId, { env: fixture.run.env }))?.phase).toBe(
          "validating",
        );
        expect(fixture.events).toContain("canary");
      } finally {
        if (releaseTurn) {
          clearImmediate(releaseTurn);
        }
        foreign?.close();
      }
    });
  });

  it("refuses downstream work after an interrupted staging receipt", async () => {
    await withPhase("staging", async (fixture) => {
      let received = false;
      const inspect = gitAdmission.recordInspectedGitTarget;
      const inspected = vi
        .spyOn(gitAdmission, "recordInspectedGitTarget")
        .mockImplementation(async (...args) => {
          await inspect(...args);
          received = true;
          fixture.run.interrupted = true;
        });
      try {
        expect(await fixture.start()).toMatchObject({
          mutationStarted: false,
          result: { status: "error" },
        });
        expect(received).toBe(true);
        expect(fixture.events).toEqual([]);
      } finally {
        inspected.mockRestore();
      }
    });
  });

  it.each(["missing-row", "recovery-required", "missing-reply"] as const)(
    "keeps %s distinct from a successful validating receipt",
    async (failure) =>
      withPhase("validating", async (fixture) => {
        const original = phaseWrites.recordUpdateRunPhaseAsync;
        let receiptAttempted = false;
        const worker = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
        const phaseWrite = vi
          .spyOn(phaseWrites, "recordUpdateRunPhaseAsync")
          .mockImplementation(async (...args) => {
            receiptAttempted = true;
            if (failure === "missing-row") {
              openOpenClawStateDatabase({ env: fixture.run.env })
                .db.prepare("DELETE FROM update_runs WHERE run_id = ?")
                .run(fixture.run.runId);
            } else if (failure === "recovery-required") {
              const from = {
                root: fixture.root,
                nodePath: process.execPath,
                version: "1.0.0",
                buildId: null,
              };
              createRetainedUpdateRecovery(
                { runId: fixture.run.runId, from, to: { ...from, version: "2.0.0" } },
                { env: fixture.run.env },
              );
            } else {
              worker.mockResolvedValueOnce(undefined);
            }
            return original(...args);
          });
        try {
          const result = await fixture.start();
          expect(receiptAttempted).toBe(true);
          expect(worker).toHaveBeenCalledOnce();
          expect(result).toMatchObject({ mutationStarted: false, result: { status: "error" } });
          expect(fixture.events).toEqual([]);
          if (failure === "missing-row") {
            expect(result?.failure?.detail).toContain("Unknown update run");
            expect(
              await getUpdateRunAsync(fixture.run.runId, { env: fixture.run.env }),
            ).toBeUndefined();
          } else if (failure === "missing-reply") {
            expect(result?.failure?.detail).toContain("Update history disappeared");
          } else {
            expect(result?.failure?.cause).toMatchObject({
              name: "UpdateRecoveryRequiredError",
              record: { runId: fixture.run.runId },
            });
          }
        } finally {
          phaseWrite.mockRestore();
          worker.mockRestore();
        }
      }),
  );

  it("preserves a terminal phase no-op while live custody permits validation", async () => {
    await withPhase("validating", async (fixture) => {
      const terminal = finishUpdateRun(
        fixture.run.runId,
        { status: "skipped", reason: "already-current" },
        { env: fixture.run.env },
      );
      expect(await fixture.start()).toMatchObject({ result: { status: "ok" } });
      expect(fixture.events).toContain("canary");
      expect(await getUpdateRunAsync(fixture.run.runId, { env: fixture.run.env })).toEqual(
        terminal,
      );
    });
  });

  it.each(["ordinary", "unknown"] as const)(
    "preserves a phase %s error before delivery",
    async (outcome) =>
      withPhase("validating", async (fixture) => {
        const original = stateWorker.runOpenClawStateWorkerOperation;
        const originalError =
          outcome === "unknown"
            ? new SqliteWorkerError("phase acknowledgement lost", "outcome-unknown")
            : new Error("phase acknowledgement failed");
        const worker = vi
          .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
          .mockImplementation(async (...args) => {
            await original(...args);
            throw originalError;
          });
        try {
          const observed = await fixture.start().then(
            (result) => result?.failure?.cause,
            (error: unknown) => error,
          );
          expect(hasCommandProcessCleanupError(observed)).toBe(outcome === "unknown");
          expect(collectNestedErrorCandidates(observed)).toContain(originalError);
          expect(fixture.events).toEqual([]);
        } finally {
          worker.mockRestore();
        }
      }),
  );
}
