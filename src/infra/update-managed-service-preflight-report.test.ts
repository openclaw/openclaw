import { expect, it } from "vitest";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { createUpdatePreflightFailure } from "./update-preflight-details.js";
import { renderUpdateRunReport, updateRunReportInputFromResult } from "./update-run-report.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import type { UpdateRunResult } from "./update-runner-types.js";

it.each([
  ["inside-gateway-service", "independent terminal outside the service"],
  [
    "service-membership-unverified",
    "openclaw gateway stop && openclaw update --yes && openclaw gateway start",
  ],
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

it.each([
  ["git-runtime-gateway-running", "Git runtime artifacts cannot be replaced"],
  ["installation-shared-by-gateway", "Another managed Gateway (Scheduled Task, Startup entry"],
  ["runtime-artifact-gateway-unverified", "Runtime artifacts must be republished"],
] as const)("names the runtime publication refusal %s without paths", async (code, guidance) => {
  const result: UpdateRunResult = {
    mode: "npm",
    status: "error",
    reason: "runtime-artifact-publication",
    steps: [
      {
        name: "runtime-artifact-publication",
        command: "openclaw update",
        cwd: "C:\\Users\\Fixture Person\\AppData\\Roaming\\npm\\node_modules\\openclaw",
        durationMs: 0,
        exitCode: 1,
        stderrTail:
          'Cannot replace C:\\Users\\Fixture Person\\AppData\\Roaming\\npm\\node_modules\\openclaw: another managed Gateway (Startup entry "C:\\Users\\Fixture Person\\Startup\\OpenClaw Gateway.cmd") is still using this installation.',
        failureFacts: createUpdatePreflightFailure(code, undefined, "runtime-artifact-publication")
          .failureFacts,
      },
    ],
    durationMs: 0,
  };
  const report = await prepareUpdateFailureReport(
    { attemptId: "runtime-publication", result },
    { env: {}, stateDir: "/report-test-state" },
  );
  expect(report.body).toContain(
    `Failing check runtime-artifact-publication (${code}): ${guidance}`,
  );
  for (const privateText of ["Fixture Person", "node_modules", "OpenClaw Gateway.cmd"]) {
    expect(report.body).not.toContain(privateText);
  }
});
