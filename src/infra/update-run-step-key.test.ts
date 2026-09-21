import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { VERSION } from "../version.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { buildUpdateRestartSentinelPayload } from "./update-restart-sentinel-payload.js";
import { createUpdateRun, getUpdateRun, recordUpdateRunStep } from "./update-run-ledger.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import type { UpdateRunResult } from "./update-runner-types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

// v2026.9.4 update-run-schema.ts:18 and gateway/server-methods/update-report.ts:111.
// That reader drops exitCode from ledger rows and joins the sentinel by exact name.
const releasedSteps = z
  .array(
    z.object({
      step: z.string().max(1024),
      status: z.enum(["pending", "in_progress", "completed", "failed", "skipped"]),
      startedAtMs: z.number().int().nonnegative().optional(),
      endedAtMs: z.number().int().nonnegative().optional(),
      detail: z.string().max(1024).optional(),
    }),
  )
  .max(128);

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
  const recorded = getUpdateRun(run.runId, options);
  if (!recorded) {
    throw new Error("Missing recorded update run");
  }
  const decoded = releasedSteps.parse(recorded.steps);
  expect(decoded).toEqual([
    ...releasedSteps.parse(run.steps),
    {
      step: releasedName,
      status: "failed",
      startedAtMs: 1,
      endedAtMs: 2,
      detail: "timeout; Synthetic timeout",
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
  expect(sentinel.stats?.steps?.map((entry) => entry.name)).toEqual([releasedName]);
  expect(
    decoded
      .filter((entry) => entry.status === "failed")
      .map(
        (entry) =>
          sentinel.stats?.steps?.find(
            (measured) => !measured.advisory && measured.name === entry.step,
          )?.log?.exitCode,
      ),
  ).toEqual([0]);
  const report = await prepareUpdateFailureReport(
    { attemptId: run.runId, result, recordedRun: recorded },
    options,
  );
  expect(report.title).toBe(`Update failure: ${name} (${VERSION})`);
  expect(report.body.split("\n").filter((line) => line.startsWith("- Failed phase:"))).toEqual([
    `- Failed phase: ${name}`,
  ]);
});
