import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "./update-run-ledger.js";
import { UpdateRunRecordSchema } from "./update-run-schema.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

it.each([1, 40])(
  "retains a bounded lint receipt with %i errors after ledger compaction",
  (errorCount) => {
    const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("update-lint-receipt-") } };
    const run = createUpdateRun({ trigger: "cli" }, options);
    const physical = {
      exitCode: 1,
      termination: "timeout" as const,
      signal: "SIGTERM" as const,
      killed: true,
      outputLimitExceeded: true,
    };
    const findings = Array.from({ length: 40 }, (_, index) => ({
      checkId: `fixture/check-${index}`,
      severity: index < errorCount ? "error" : "warning",
      message: index === 0 ? "Candidate configuration cannot start" : "🦞".repeat(100),
    }));
    for (const step of updateRunStepsFromResultStep({
      name: "candidate doctor lint",
      ...physical,
      doctorLintFindings: findings,
    })) {
      recordUpdateRunStep(run.runId, step, options);
    }
    // Force retained-step detail compaction, then another write and database reopen.
    for (let index = 0; index < 24; index++) {
      recordUpdateRunStep(
        run.runId,
        {
          step: `finalize:fixture-${index}`,
          status: "completed",
          detail: "detail ".repeat(140),
        },
        options,
      );
    }
    finishUpdateRun(run.runId, { status: "failed", reason: "doctor-failed" }, options);
    closeOpenClawStateDatabaseForTest();
    const retained = getUpdateRun(run.runId, options)!;
    // v2026.9.4 rewrites whole records with this step-field projection.
    const published = UpdateRunRecordSchema.extend({
      steps: z.array(
        UpdateRunRecordSchema.shape.steps.element.pick({
          step: true,
          status: true,
          startedAtMs: true,
          endedAtMs: true,
          detail: true,
        }),
      ),
    }).parse(retained);
    expect(published.steps.every((step) => !("exitCode" in step))).toBe(true);
    const receipt = published.steps.find(
      (step) => step.step === "finalize:doctor-lint:candidate doctor lint",
    )!;
    expect(receipt.detail).toBeDefined();
    expect(Buffer.byteLength(receipt.detail!)).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(JSON.stringify(retained.steps))).toBeLessThanOrEqual(16 * 1024);
    const summary = JSON.parse(receipt.detail!);
    expect(summary).toMatchObject(physical);
    expect(summary.counts).toEqual({ error: errorCount, warning: 40 - errorCount, info: 0 });
    expect(summary.errors[0]).toEqual({
      checkId: findings[0]!.checkId,
      message: findings[0]!.message,
    });
    expect(summary.errors.length + summary.omitted).toBe(errorCount);
    if (errorCount === 1) {
      expect(summary.omitted).toBe(0);
    } else {
      expect(summary.omitted).toBeGreaterThan(0);
    }
    expect(retained.status).toBe("failed");
  },
);
