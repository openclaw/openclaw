import { describe, expect, it } from "vitest";
import { applyUpdateDoctorLintReport } from "./update-doctor-lint.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import type { UpdateStepResult } from "./update-step-result.js";

function deferredReport(checksRun: number) {
  return JSON.stringify({
    ok: true,
    checksRun,
    findings: [],
    warnings: [
      {
        checkId: "core/doctor/lint-inspection",
        severity: "warning",
        errorCode: "update-inspection-deferred",
        requirement: "update-validation-budget",
        message:
          "Doctor lint inspection deferred until after activation: 2 agent scopes need a 4000ms inspection allowance, with 0ms remaining in the validation inspection window (validation-ledger).",
        fixHint:
          "Run `openclaw doctor --fix` after activation to complete deferred checks and repairs.",
      },
    ],
  });
}

function step(): UpdateStepResult {
  return {
    name: "candidate-doctor-lint",
    command: "doctor --lint --json --severity-min error",
    cwd: "/tmp/openclaw-fixture",
    durationMs: 1,
    exitCode: 0,
  };
}

describe("applyUpdateDoctorLintReport budget deferral", () => {
  it.each([0, 1])(
    "marks budget-deferred lint advisory after %i checks without failing the step",
    (checksRun) => {
      const lintStep = step();
      applyUpdateDoctorLintReport(lintStep, deferredReport(checksRun), 0, {});
      expect(lintStep.advisory).toEqual({
        kind: "recoverable-maintenance",
        message: `Doctor deferred 1 inspection until after activation (${checksRun} ran). Run \`openclaw doctor --fix\` after the update.`,
      });
      expect(lintStep.exitCode).toBe(0);
      expect(isFailedUpdateStep(lintStep)).toBe(false);
      expect(lintStep.warnings?.join("\n")).toContain("update-validation-budget");
    },
  );

  it("leaves a successful report with no deferred inspection as a plain pass", () => {
    const lintStep = step();
    applyUpdateDoctorLintReport(
      lintStep,
      JSON.stringify({ ok: true, checksRun: 2, findings: [], warnings: [] }),
      0,
      {},
    );
    expect(lintStep.advisory).toBeUndefined();
    expect(isFailedUpdateStep(lintStep)).toBe(false);
  });
});
