import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { buildUpdateRestartSentinelPayload } from "./update-restart-sentinel-payload.js";
import { createUpdateRun, getUpdateRun, recordUpdateRunStep } from "./update-run-ledger.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import type { UpdateRunResult } from "./update-runner-types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);

// The v2026.9.4 reader drops exitCode and joins ledger and sentinel by exact name.
it.each([
  ["package-install", "global update"],
  ["package-install-omit-optional", "global update (omit optional)"],
  ["git-fetch", "git fetch"],
  ["git-fetch-tags", "git fetch tags"],
  ["git-fetch-target-tag", "git fetch target tag"],
  ["git-target-inspection-fetch", "git target inspection fetch"],
  ["git-import-admitted-target", "git import admitted target"],
])("preserves released ledger/sentinel joins for %s", async (name, releasedName) => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("released-step-key-") } };
  const run = createUpdateRun({ trigger: "cli" }, options);
  recordUpdateRunStep(run.runId, { step: name, status: "in_progress", startedAtMs: 1 }, options);
  const step = {
    name,
    command: "synthetic install",
    cwd: "/synthetic",
    durationMs: 1,
    exitCode: 0,
    termination: "timeout" as const,
    stderrTail: "Synthetic timeout",
  };
  for (const receipt of updateRunStepsFromResultStep(step)) {
    recordUpdateRunStep(run.runId, { ...receipt, endedAtMs: 2 }, options);
  }
  const recorded = getUpdateRun(run.runId, options)!;
  expect(recorded.steps).toMatchObject([
    ...run.steps,
    {
      step: releasedName,
      status: "failed",
    },
  ]);
  const result: UpdateRunResult = {
    runId: run.runId,
    status: "error",
    mode: "npm",
    reason: "global-install-failed",
    steps: [step],
    durationMs: 1,
  };
  const sentinel = buildUpdateRestartSentinelPayload({ result, meta: {} });
  expect(
    sentinel.stats?.steps?.map(({ name: key, log, advisory }) => [key, log?.exitCode, advisory]),
  ).toEqual([[releasedName, 0, undefined]]);
});

it("retains bounded informational diagnostics without warnings or raw process output", () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("update-diagnostics-") } };
  const run = createUpdateRun({ trigger: "cli" }, options);
  const diagnostics = ["Snapshot needs 18 GiB.", "SQLite family: 3.6 GiB.", "x".repeat(2048)];
  for (const receipt of updateRunStepsFromResultStep({
    name: "snapshot-space-preflight",
    exitCode: 0,
    diagnostics,
    stdoutTail: "RAW_PROCESS_OUTPUT",
  })) {
    recordUpdateRunStep(run.runId, receipt, options);
  }
  const recorded = getUpdateRun(run.runId, options)!;
  expect(
    recorded.steps.filter((step) => step.step.startsWith("diagnostic:")).map((step) => step.detail),
  ).toEqual([diagnostics[0], diagnostics[1], "x".repeat(1024)]);
  expect(recorded.steps.some((step) => step.step.startsWith("warning:"))).toBe(false);
  expect(JSON.stringify(recorded)).not.toContain("RAW_PROCESS_OUTPUT");
});

// Settlement clears warnings, not the original process classification.
it.each([{ warnings: undefined }, { warnings: [] }])(
  "projects an advisory with explicit warnings $warnings",
  ({ warnings }) => {
    const steps = updateRunStepsFromResultStep({
      name: "package-doctor",
      exitCode: 86,
      warnings,
      advisory: { kind: "package-post-install-doctor", message: "Doctor advisory." },
    });
    expect(steps[0]).toMatchObject({ status: "completed", exitCode: 86 });
    expect(steps.filter((step) => step.step.startsWith("warning:"))).toEqual(
      warnings ? [] : [expect.objectContaining({ detail: "Doctor advisory." })],
    );
  },
);
