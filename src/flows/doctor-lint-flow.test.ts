import { expect, it } from "vitest";
import { OpenClawStateLeaseAcquisitionError } from "../state/openclaw-state-lease-error.js";
import { exitCodeFromFindings, runDoctorLintChecks } from "./doctor-lint-flow.js";
import * as registry from "./health-check-registry.js";
import type { HealthCheck, HealthCheckContext, HealthFinding } from "./health-checks.js";

const noop = () => {};
const ctx: HealthCheckContext = {
  mode: "lint",
  runtime: { log: noop, error: noop, exit: noop },
  cfg: {},
};

function check(id: string, detect: HealthCheck["detect"]): HealthCheck {
  return { id, kind: "core", description: id, detect };
}

function errorFinding(checkId: string, message: string): HealthFinding {
  return { checkId, severity: "error", message };
}

function selectionFinding(path: string, message: string): HealthFinding {
  return { ...errorFinding("core/doctor/lint-selection", message), path };
}

function throwingCheck(id: string, error: Error): HealthCheck {
  return check(id, async () => {
    throw error;
  });
}

it("reports conflicting selectors for a registered health check", async () => {
  const ids = ["plugin/example/first", "plugin/example/second"];
  let detections = 0;
  const existingChecks = registry.listHealthChecks();
  for (const id of ids) {
    registry.registerHealthCheck(
      check(id, async () => {
        detections += 1;
        return [{ checkId: id, severity: "error", message: "critical failure" }];
      }),
    );
  }

  try {
    const selectors = new Set(ids);
    const result = await runDoctorLintChecks(ctx, { onlyIds: selectors, skipIds: selectors });

    expect(detections).toBe(0);
    expect(result).toEqual({
      checksRun: 0,
      checksSkipped: 2,
      findings: ids.map((id) =>
        selectionFinding(
          id,
          `Health check ${id} cannot be selected by --only and excluded by --skip.`,
        ),
      ),
    });
    expect(exitCodeFromFindings(result.findings)).toBe(1);
  } finally {
    registry.clearHealthChecksForTest();
    for (const existingCheck of existingChecks) {
      registry.registerHealthCheck(existingCheck);
    }
  }
});

it("keeps unknown-only diagnostics without treating partial overlap as an error", async () => {
  const skippedId = "plugin/example/skipped";
  const selectedId = "plugin/example/selected";
  const unknownId = "plugin/future/not-loaded";
  const detections: string[] = [];
  const result = await runDoctorLintChecks(ctx, {
    checks: [skippedId, selectedId].map((id) =>
      check(id, async () => {
        detections.push(id);
        return [];
      }),
    ),
    onlyIds: [skippedId, unknownId, selectedId],
    skipIds: [skippedId, "plugin/future/ignored"],
  });

  expect(result).toMatchObject({ checksRun: 1, checksSkipped: 1 });
  expect(detections).toEqual([selectedId]);
  expect(result.findings).toEqual([
    selectionFinding(unknownId, `Unknown health check id selected by --only: ${unknownId}.`),
  ]);
  expect(exitCodeFromFindings(result.findings)).toBe(1);
});

it("records acquisition cancellation without diagnosing a failed inspection", async () => {
  const result = await runDoctorLintChecks(ctx, {
    checks: [
      throwingCheck(
        "cancelled",
        new OpenClawStateLeaseAcquisitionError("state lease fixture", {
          kind: "aborted",
          reason: "caller-signal",
          elapsedMs: 250,
        }),
      ),
      check("next", async () => [{ checkId: "next", severity: "info", message: "inspected" }]),
    ],
  });

  expect(result).toEqual({
    checksRun: 2,
    checksSkipped: 0,
    findings: [
      {
        checkId: "cancelled",
        severity: "info",
        message:
          "state lease inspection not performed: aborted after 250 ms by the caller's signal",
        errorCode: "OPENCLAW_STATE_LEASE_ABORTED",
      },
      { checkId: "next", severity: "info", message: "inspected" },
    ],
  });
  expect(exitCodeFromFindings(result.findings)).toBe(0);
});

it.each([
  {
    name: "held leases",
    error: new OpenClawStateLeaseAcquisitionError("state lease fixture", {
      kind: "held",
      holder: { owner: "another-owner", epoch: 1 },
    }),
  },
  {
    name: "UTF-16 truncation",
    error: new Error(`${"A".repeat(252)}\u{1F600}${"B".repeat(10)}`),
    expected: `${"A".repeat(252)}...`,
  },
])("reports $name as errors", async ({ error, expected }) => {
  const result = await runDoctorLintChecks(ctx, { checks: [throwingCheck("boom", error)] });
  expect(result.findings).toEqual([
    errorFinding("boom", `health check threw: ${expected ?? error.message}`),
  ]);
  expect(exitCodeFromFindings(result.findings)).toBe(1);
});
