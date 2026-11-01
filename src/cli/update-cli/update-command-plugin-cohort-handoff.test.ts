import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { PluginCohortRecovery } from "../../infra/update-plugin-cohort-schema.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRecoveryRecord } from "../../infra/update-run-recovery-schema.js";
import {
  beginPluginCohortRecovery,
  loadPluginCohortRecovery,
} from "../../infra/update-run-recovery-store.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { useExecutorFixture } from "./update-command-executor.test-support.js";
import { completeUpdateCommandRun } from "./update-command-run.js";
import { prepareSettledUpdateCommandResult } from "./update-command-terminal-publication.js";
import {
  deferUpdateCommandTerminalPreparation,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";

const fixture = useExecutorFixture("foreground-cohort-owner-");

it("hands a matching pending cohort to Gateway readiness only under its actual live executor", async () => {
  const { root } = fixture();
  await withOpenClawTestState({ label: "foreground-cohort-publication" }, async (state) => {
    await state.writeConfig({ plugins: { enabled: false } });
    const { runId } = createUpdateRun({ trigger: "api" }, { env: state.env });
    const reservation: UpdateRecoveryRecord = {
      runId,
      transactionId: randomUUID(),
      revision: 0,
      claimId: randomUUID(),
      claimKind: "initial",
      handoff: null,
      source: { stateDir: state.stateDir, configPath: state.configPath },
      from: { root, nodePath: process.execPath, version: "2026.10.9", buildId: "original" },
      to: { root, nodePath: process.execPath, version: "2026.10.10", buildId: "candidate" },
      createdAtMs: 1,
      updatedAtMs: 1,
      effects: [],
      restore: null,
      verification: null,
      primaryFailure: null,
    };
    const cohort: PluginCohortRecovery = {
      runId,
      transactionId: reservation.transactionId,
      revision: 0,
      disposition: "pending",
      installKey: root,
      priorArtifacts: [],
      artifacts: [],
      publications: [],
      settledPublications: 0,
    };
    const input: UpdateRunResult = {
      status: "ok",
      mode: "npm",
      root,
      before: { version: "2026.10.9", buildId: "original" },
      after: { version: "2026.10.10", buildId: "candidate" },
      steps: [],
      durationMs: 1,
    };
    let admitted: NonNullable<UpdateCommandOptions["run"]> | undefined;
    await withUpdateCommandTerminalResult(async (registerRun) =>
      withUpdateCommandExecutor(runId, async (executor) => {
        const fence = await executor.enter(root);
        beginPluginCohortRecovery(reservation, cohort, fence, { env: state.env });
        const run: NonNullable<UpdateCommandOptions["run"]> = {
          runId,
          env: state.env,
          executorFence: fence,
          completionOwner: "gateway-restart",
          gatewayRestartRequired: true,
        };
        admitted = run;
        const recoveryState = { triageTarget: { root, env: state.env } };
        await expect(
          withUpdateCommandRecoveryUnwind({ run }, recoveryState, async () => {}),
        ).rejects.toThrow("unfinished recovery");
        registerRun(run);
        expect(
          deferUpdateCommandTerminalPreparation(
            run,
            (failure) => {
              expect(failure).toBeUndefined();
              return prepareSettledUpdateCommandResult(
                { opts: { run, json: true }, root, startedAt: Date.now() },
                {
                  pendingResult: input,
                  failure,
                  readReportingState: () => ({ rolledBack: false }),
                },
                () => fence.assertCurrent(),
              );
            },
            () => input,
          ),
        ).toBe(true);
        await expect(
          withUpdateCommandRecoveryUnwind({ run }, recoveryState, async () => {
            throw new Error("foreground operation failed");
          }),
        ).rejects.toThrow("unfinished recovery");
        expect(completeUpdateCommandRun(input, run)).toMatchObject({ status: "ok", runId });
        expect(getUpdateRun(runId, { env: state.env })).toMatchObject({
          status: "running",
          phase: "restarting",
        });
        expect(loadPluginCohortRecovery(runId, { env: state.env })?.cohort.disposition).toBe(
          "pending",
        );
        await withUpdateCommandRecoveryUnwind({ run }, recoveryState, async () => {});
        expect(completeUpdateCommandRun(input, { ...run, executorFence: undefined })).toMatchObject(
          {
            status: "error",
            reason: "update-recovery-pending",
          },
        );
        expect(() =>
          completeUpdateCommandRun({ ...input, after: { version: "wrong" } }, run),
        ).toThrow("retained candidate");
      }),
    );
    expect(() => completeUpdateCommandRun(input, admitted)).toThrow();
    expect(getUpdateRun(runId, { env: state.env })).toMatchObject({
      status: "running",
      phase: "restarting",
    });
    expect(loadPluginCohortRecovery(runId, { env: state.env })).toBeDefined();
  });
});
