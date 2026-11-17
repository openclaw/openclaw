import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as ledger from "../../infra/update-run-ledger.js";
import * as state from "../../state/openclaw-state-db.js";
import { recordOwedUpdateStep, settleOwedStepsAfterFinalization } from "./update-command-owed.js";
import {
  createOwedPluginStepWarning,
  createPostCorePluginUpdateResult,
} from "./update-command-plugins-internals.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.useRealTimers();
  await state.closeOpenClawStateDatabaseAsync();
  state.closeOpenClawStateDatabaseForTest();
});

it("leaves a step owed by the earlier update when the update that took it over fails", () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-update-owed-") } };
  // Runs are ordered by creation time.
  vi.useFakeTimers({ toFake: ["Date"], now: 1_800_000_000_000 });
  const earlier = ledger.createUpdateRun({ trigger: "cli" }, options).runId;
  ledger.finishUpdateRun(earlier, { status: "succeeded" }, options);
  ledger.recordUpdateRunOwedStep(earlier, "service-definition", "install failed", options);
  vi.advanceTimersByTime(1_000);
  const later = ledger.createUpdateRun({ trigger: "cli" }, options).runId;
  const again = { id: "service-definition" as const, reason: "install failed again" };

  expect(recordOwedUpdateStep({ runId: later, ...options }, again)).toBe(true);
  expect(ledger.readOwedUpdateSteps(options)).toEqual([{ ...again, runId: later }]);

  ledger.finishUpdateRun(later, { status: "failed" }, options);

  expect(ledger.readOwedUpdateSteps(options)).toEqual([
    { id: "service-definition", runId: earlier, reason: "install failed" },
  ]);
});

it.each([
  { phase: "kept its result", status: "warning", owes: true },
  { phase: "failed", status: "error", owes: false },
] as const)(
  "repair owes a plugin step only when its plugin phase $phase",
  async ({ status, owes }) => {
    const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-update-owed-") } };
    const run = { runId: ledger.createUpdateRun({ trigger: "cli" }, options).runId, ...options };
    const step = { id: "post-plugin-doctor" as const, reason: "state database is locked" };
    const plugins = createPostCorePluginUpdateResult({
      status,
      warnings: [createOwedPluginStepWarning(step.id, new Error(step.reason))],
    });

    const reported = await settleOwedStepsAfterFinalization(run, {
      root: "/unused",
      plugins,
      timeoutMs: 1_000,
    });

    expect(reported).toEqual(owes ? [step] : []);
    expect(ledger.readOwedUpdateSteps(options)).toEqual(
      owes ? [{ ...step, runId: run.runId }] : [],
    );
  },
);
