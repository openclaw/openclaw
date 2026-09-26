import { existsSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
} from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";
import { inspectUpdateRunDriver, readUpdateRunDriver } from "./update-run-driver.js";
import type { InterruptedUpdateSettlement } from "./update-run-interruption-contract.js";
import { createUpdateRun, recordUpdateRunPhase, recordUpdateRunStep } from "./update-run-ledger.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "update-interruption-worker-", applyEnv: true });
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

it("publishes interrupted cleanup through workers only against its captured run revision", async () => {
  const options = { env: state.env };
  const ownDriver = readUpdateRunDriver();
  if (!ownDriver) {
    throw new Error("The worker fixture requires its native process identity");
  }
  // A different native start identity represents the previous owner of this reused PID.
  const driver = { ...ownDriver, startIdentity: ownDriver.startIdentity === "0" ? "1" : "0" };
  expect(inspectUpdateRunDriver(driver)).toBe("dead");
  const run = createUpdateRun({ trigger: "cli", origin: { driver } }, options);
  recordUpdateRunStep(
    run.runId,
    {
      step: "finalize:installed-candidate",
      status: "completed",
      detail: JSON.stringify({ version: "2026.9.4", buildId: "worker-candidate" }),
    },
    options,
  );
  recordUpdateRunStep(
    run.runId,
    { step: "post-update verification", status: "completed" },
    options,
  );
  recordUpdateRunPhase(run.runId, "verifying", {}, options);
  const read = () =>
    withArtifactPreservingStateReads(() =>
      executeExistingOpenClawStateRead(options, { type: "updateRuns.interruptedCandidate" }),
    );
  const snapshot = await read();
  if (!snapshot?.ok || snapshot.type !== "updateRuns.interruptedCandidate" || !snapshot.run) {
    throw new Error("The read worker did not return the interrupted candidate");
  }
  expect(snapshot.run.runId).toBe(run.runId);
  const context = captureOpenClawStateWorkerContext(options);
  const publish = (input: InterruptedUpdateSettlement, target = context) =>
    runOpenClawStateWorkerOperation(
      target,
      (scope) => scope.execute({ type: "updateRuns.reconcileInterrupted", input }),
      {
        existingOnly: true,
        createAdmission: createSqliteWorkerWriteAdmission(
          () => target.admission.assertCurrent(),
          [target.admission.databasePath],
        ),
      },
    );
  const pending = await publish({
    expected: snapshot.run,
    detail: "Timeout; cleanup pending",
    cleanup: "pending",
  });
  expect(pending).toMatchObject({ accepted: true, run: { status: "running" } });
  const captured = pending?.run;
  if (!captured) {
    throw new Error("The write worker did not publish the pending observation");
  }
  const failed = await publish({
    expected: captured,
    detail: "Timeout; cleanup failed",
    cleanup: "unknown",
  });
  expect(failed).toMatchObject({
    accepted: true,
    run: {
      status: "running",
      updatedAtMs: captured.updatedAtMs,
      steps: expect.arrayContaining([
        {
          step: "reconcile:settle",
          status: "failed",
          endedAtMs: captured.steps.find((step) => step.step === "reconcile:settle")?.endedAtMs,
          detail: "Timeout; cleanup failed",
        },
      ]),
    },
  });
  const expected = failed?.run;
  if (!expected) {
    throw new Error("The write worker did not publish cleanup uncertainty");
  }
  recordUpdateRunStep(
    run.runId,
    { step: "warning:fixture:new-owner", status: "completed" },
    options,
  );
  await expect(
    publish({ expected, detail: "Stale cleanup completion", cleanup: "confirmed" }),
  ).resolves.toEqual({ accepted: false });
  expect(await read()).toMatchObject({
    run: {
      status: "running",
      steps: expect.arrayContaining([
        expect.objectContaining({ step: "reconcile:settle", detail: "Timeout; cleanup failed" }),
        expect.objectContaining({ step: "warning:fixture:new-owner" }),
      ]),
    },
  });
  const missing = { ...options, path: state.statePath("missing.sqlite") };
  expect(
    await executeExistingOpenClawStateRead(missing, { type: "updateRuns.interruptedCandidate" }),
  ).toBeUndefined();
  expect(
    await publish(
      { expected, detail: "Must not create state" },
      captureOpenClawStateWorkerContext(missing),
    ),
  ).toBeUndefined();
  expect(existsSync(missing.path)).toBe(false);
});
