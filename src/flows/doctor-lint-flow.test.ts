import { describe, expect, it } from "vitest";
import { exitCodeFromFindings, runDoctorLintChecks } from "./doctor-lint-flow.js";
import { defineSplitHealthCheck } from "./health-check-adapter.js";
import type { HealthCheck, HealthCheckContext, SplitHealthCheck } from "./health-checks.js";

const ctx: HealthCheckContext = {
  mode: "lint",
  runtime: {
    log() {},
    error() {},
    exit() {},
  },
  cfg: {},
};

function check(id: string, detect: SplitHealthCheck["detect"]): HealthCheck {
  return defineSplitHealthCheck({
    id,
    kind: "core",
    description: id,
    detect: detect ?? (async () => []),
  });
}

describe("runDoctorLintChecks", () => {
  it("filters selected checks and reports skipped count", async () => {
    const result = await runDoctorLintChecks(ctx, {
      checks: [
        check("a", async () => [{ checkId: "a", severity: "warning", message: "warn" }]),
        check("b", async () => [{ checkId: "b", severity: "error", message: "err" }]),
      ],
      onlyIds: ["a"],
    });

    expect(result.checksRun).toBe(1);
    expect(result.checksSkipped).toBe(1);
    expect(result.findings.map((finding) => finding.checkId)).toEqual(["a"]);
  });

  it("supports single-run checks in lint mode", async () => {
    const result = await runDoctorLintChecks(ctx, {
      checks: [
        {
          id: "run-check",
          kind: "core",
          description: "run check",
          async run(runCtx) {
            expect(runCtx).toMatchObject({
              mode: "lint",
              repair: false,
            });
            return {
              findings: [
                {
                  checkId: "run-check",
                  severity: "warning",
                  message: "warn",
                },
              ],
            };
          },
        },
      ],
    });

    expect(result.findings.map((finding) => finding.checkId)).toEqual(["run-check"]);
  });

  it("turns thrown checks into error findings", async () => {
    const result = await runDoctorLintChecks(ctx, {
      checks: [
        check("boom", async () => {
          throw new Error("nope");
        }),
      ],
    });

    expect(result.findings).toEqual([
      {
        checkId: "boom",
        severity: "error",
        message: "health check threw: nope",
      },
    ]);
  });
});

describe("exitCodeFromFindings", () => {
  it("uses the selected severity threshold", () => {
    const findings = [{ checkId: "a", severity: "warning" as const, message: "warn" }];

    expect(exitCodeFromFindings(findings, "warning")).toBe(1);
    expect(exitCodeFromFindings(findings, "error")).toBe(0);
  });
});
