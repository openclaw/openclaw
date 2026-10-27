import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { interruptedRunFixture } from "./update-run-fixture.test-support.js";
import type { InterruptedUpdateSettlement } from "./update-run-interruption-contract.js";
import {
  persistInterruptedUpdateObservationAsync,
  readInterruptedUpdateCandidateAsync,
} from "./update-run-interruption-worker.js";

it("fences interrupted cleanup by captured revision", async ({ onTestFinished }) => {
  const state = await createOpenClawTestState({ prefix: "update-interruption-" });
  onTestFinished(async () => {
    await closeOpenClawStateDatabaseAsync();
    await state.cleanup();
  });
  const options = { env: state.env };
  const run = interruptedRunFixture(options, { version: "2026.9.4", buildId: "worker-candidate" });
  const read = (target = options) => readInterruptedUpdateCandidateAsync(target);
  const snapshot = await read();
  if (!snapshot) {
    throw new Error("The read worker did not return the interrupted candidate");
  }
  expect(snapshot.runId).toBe(run.id);
  const context = captureOpenClawStateWorkerContext(options);
  const publish = (input: InterruptedUpdateSettlement, target = context) =>
    persistInterruptedUpdateObservationAsync(target, input);
  const settle = async (expected: NonNullable<typeof snapshot>, cleanup: "pending" | "unknown") => {
    const detail = `Timeout; cleanup ${cleanup === "pending" ? "pending" : "failed"}`;
    const result = await publish({ expected, cleanup, detail });
    expect(result).toMatchObject({ accepted: true, run: { status: "running" } });
    if (!result?.run) {
      throw new Error("The write worker did not publish the observation");
    }
    return result.run;
  };
  const captured = await settle(snapshot, "pending");
  const expected = await settle(captured, "unknown");
  const settlement = {
    step: "reconcile:settle",
    status: "failed",
    detail: "Timeout; cleanup failed",
  };
  expect(expected.updatedAtMs).toBe(captured.updatedAtMs);
  expect(expected.steps.find((step) => step.step === "reconcile:settle")).toEqual({
    ...settlement,
    endedAtMs: captured.steps.find((step) => step.step === "reconcile:settle")?.endedAtMs,
  });
  run.step({ step: "warning:fixture:new-owner", status: "completed" });
  await expect(
    publish({ expected, detail: "Stale cleanup completion", cleanup: "confirmed" }),
  ).resolves.toEqual({ accepted: false });
  expect(await read()).toMatchObject({
    status: "running",
    steps: expect.arrayContaining([
      expect.objectContaining(settlement),
      expect.objectContaining({ step: "warning:fixture:new-owner" }),
    ]),
  });
  const missing = { ...options, path: state.statePath("missing.sqlite") };
  const missingContext = captureOpenClawStateWorkerContext(missing);
  expect(await read(missing)).toBeUndefined();
  expect(
    await publish({ expected, detail: "Must not create state" }, missingContext),
  ).toBeUndefined();
  expect(existsSync(missing.path)).toBe(false);
});
