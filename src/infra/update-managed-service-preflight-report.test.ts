import { expect, it } from "vitest";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { renderUpdateRunReport, updateRunReportInputFromResult } from "./update-run-report.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import type { UpdateRunResult } from "./update-runner-types.js";

it.each([
  ["inside-gateway-service", "independent terminal outside the service"],
  ["service-membership-unverified", "restoring native process inspection"],
  ["inside-gateway-process-tree", "a terminal outside the Gateway process tree"],
  ["service-not-offline", "Stop it through its service owner"],
  ["service-definition-not-writable", "writable service definition"],
  ["service-context-changed", "Retry openclaw update"],
])("reports the managed-service refusal %s without private diagnostics", async (code, guidance) => {
  const step = {
    name: "managed-service-preflight",
    command: "openclaw update",
    cwd: "/Users/Fixture Person/private-install",
    durationMs: 0,
    exitCode: 1,
    failureFacts: [
      {
        check: "managed-service-preflight",
        code,
        message: "Gateway PID 812345 uses /Users/Fixture Person/private-install",
      },
    ],
  };
  for (const recorded of [false, true]) {
    const result: UpdateRunResult = {
      mode: "npm",
      status: "error",
      reason: "managed-service-preflight",
      steps: recorded ? [] : [step],
      durationMs: 0,
    };
    const recordedRun = recorded
      ? { runId: "managed-preflight", steps: updateRunStepsFromResultStep(step) }
      : undefined;
    const report = await prepareUpdateFailureReport(
      { attemptId: "managed-preflight", result, recordedRun },
      { env: {}, stateDir: "/report-test-state" },
    );
    expect(report.body).toContain(`Failing check managed-service-preflight (${code})`);
    expect(report.body).toContain(guidance);
    for (const privateText of ["Fixture Person", "private-install", "812345"]) {
      expect(report.body).not.toContain(privateText);
    }
    const local = renderUpdateRunReport(updateRunReportInputFromResult(result, recordedRun));
    expect(local.lines.join("\n")).toContain(`Failing check managed-service-preflight (${code})`);
  }
});
