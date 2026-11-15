import { expect, it } from "vitest";
import { preparePublicUpdateFailureIdentifiers } from "./update-failure-public-identifiers.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { finishUpdateRunRecord, type UpdateRunRecord } from "./update-run-record.js";

function running(steps: UpdateRunRecord["steps"] = []): UpdateRunRecord {
  return {
    runId: "6631ecee-adbf-41e8-a0e3-1b88b28b0a59",
    createdAtMs: 1,
    updatedAtMs: 1,
    trigger: "cli",
    phase: "staging",
    status: "running",
    reason: null,
    origin: {},
    target: { kind: "package" },
    before: { version: "2026.11.3" },
    after: {},
    steps,
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: null,
    downtimeMs: null,
  };
}

it.each<{
  label: string;
  steps?: UpdateRunRecord["steps"];
  result: Parameters<typeof finishUpdateRunRecord>[1];
  cause: string;
}>([
  {
    label: "success",
    result: { status: "succeeded" },
    cause: "none",
  },
  {
    label: "Node refusal",
    result: { status: "failed", reason: "preflight-node-runtime-incompatible" },
    cause: "node-unsupported",
  },
  {
    // The field's largest bucket: the site code hid ENOSPC behind global-install-failed.
    label: "npm ENOSPC behind a generic install failure",
    steps: [
      {
        step: "package-install",
        status: "failed",
        failureFacts: [{ check: "npm", code: "global-install-failed", npmErrorCode: "ENOSPC" }],
      },
    ],
    result: { status: "failed", reason: "global-install-failed" },
    cause: "disk-full",
  },
  {
    label: "unrecognized failure",
    result: { status: "failed", reason: "something-new" },
    cause: "unknown",
  },
])("records the $label cause on the terminal record", ({ steps, result, cause }) => {
  const record = running(steps);
  finishUpdateRunRecord(record, result);
  expect(record.phase).toBe("finished");
  expect(record.origin.cause).toBe(cause);
});

it("names the real cause in the auto report even when the step text is redacted", async () => {
  // 276 field reports read "Reason code: global-install-failed" with the npm detail redacted.
  await preparePublicUpdateFailureIdentifiers();
  const prepared = await prepareUpdateFailureReport(
    {
      attemptId: "report-test",
      result: {
        mode: "npm",
        status: "error",
        reason: "global-install-failed",
        durationMs: 1,
        steps: [
          {
            name: "package install",
            command: "",
            cwd: "",
            durationMs: 1,
            exitCode: 1,
            failureFacts: [{ check: "npm", code: "global-install-failed", npmErrorCode: "ENOSPC" }],
            stderrTail: "npm error nospc /private/customer/lib/node_modules",
          },
        ],
      },
    },
    { env: {}, stateDir: "/report-test-state" },
  );
  expect(prepared.body).toContain("- Reason code: global-install-failed");
  expect(prepared.body).toContain("- Cause: disk-full");
  expect(prepared.body).not.toContain("/private/customer");
});
