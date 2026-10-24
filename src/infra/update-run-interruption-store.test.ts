import { existsSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
} from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { inspectUpdateRunDriver } from "./update-run-driver.js";
import { interruptedRunFixture } from "./update-run-fixture.test-support.js";
import type { InterruptedUpdateSettlement } from "./update-run-interruption-contract.js";
import { persistInterruptedUpdateObservationAsync } from "./update-run-interruption-worker.js";

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
  const run = interruptedRunFixture(options, { version: "2026.9.4", buildId: "worker-candidate" });
  expect(inspectUpdateRunDriver(run.driver)).toBe("dead");
  const read = () =>
    withArtifactPreservingStateReads(() =>
      executeExistingOpenClawStateRead(options, { type: "updateRuns.interruptedCandidate" }),
    );
  const snapshot = await read();
  if (!snapshot?.ok || snapshot.type !== "updateRuns.interruptedCandidate" || !snapshot.run) {
    throw new Error("The read worker did not return the interrupted candidate");
  }
  expect(snapshot.run.runId).toBe(run.id);
  const context = captureOpenClawStateWorkerContext(options);
  const publish = (input: InterruptedUpdateSettlement, target = context) =>
    persistInterruptedUpdateObservationAsync(target, input);
  const requireRun = (result: Awaited<ReturnType<typeof publish>>) => {
    if (!result?.run) {
      throw new Error("The write worker did not publish the observation");
    }
    return result.run;
  };
  const pending = await publish({
    expected: snapshot.run,
    detail: "Timeout; cleanup pending",
    cleanup: "pending",
  });
  expect(pending).toMatchObject({ accepted: true, run: { status: "running" } });
  const captured = requireRun(pending);
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
  const expected = requireRun(failed);
  run.step({ step: "warning:fixture:new-owner", status: "completed" });
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
