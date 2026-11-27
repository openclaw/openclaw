import { expect, it } from "vitest";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { failedUpdateRun } from "./update-failure-report.test-support.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

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
  const report = await prepareUpdateFailureReport(
    failedUpdateRun({
      runId: "managed-preflight",
      reason: "managed-service-preflight",
      target: { kind: "package", installationMethod: "npm-global" },
      steps: updateRunStepsFromResultStep(step),
    }),
    { env: {}, stateDir: "/report-test-state" },
  );
  expect(report.body).toContain(`Failing check managed-service-preflight (${code})`);
  expect(report.body).toContain(guidance);
  for (const privateText of ["Fixture Person", "private-install", "812345"]) {
    expect(report.body).not.toContain(privateText);
  }
});
