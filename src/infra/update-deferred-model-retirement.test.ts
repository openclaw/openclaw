import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
import { recordUpdateModelRetirement } from "./update-deferred-model-retirement.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "./update-run-ledger.js";
import { renderUpdateRunReport } from "./update-run-report.js";

const tempDirs = createTempDirTracker();
function isolatedOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-update-retirement-") } };
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  tempDirs.cleanup();
});

describe("update model-retirement warnings", () => {
  it("counts a deferred model retirement until Doctor records completion", () => {
    const options = isolatedOptions();
    const { runId } = createUpdateRun(
      { trigger: "cli", after: { version: "2026.11.10" } },
      options,
    );
    const env = { ...options.env, [UPDATE_RUN_ID_ENV]: runId };

    recordUpdateModelRetirement("deferred", env);
    const deferred = renderUpdateRunReport(
      expectDefined(getUpdateRun(runId, options), "saved update run"),
    );
    expect(deferred.lines).toContainEqual(
      expect.stringMatching(/^Warning: Model retirement repair deferred/),
    );

    recordUpdateModelRetirement("completed", env);
    finishUpdateRun(runId, { status: "succeeded" }, options);
    const saved = expectDefined(getUpdateRun(runId, options), "saved update run");
    expect(saved.steps).toContainEqual(
      expect.objectContaining({ step: "finalize:doctor:model-retirement", status: "completed" }),
    );
    const report = renderUpdateRunReport(saved);
    expect(report.headline).not.toContain("1 warning needs attention");
    expect(report.lines.filter((line) => line.startsWith("Warning: "))).toEqual([]);
    expect(saved.steps.map(({ step }) => step)).not.toContain(
      "warning:finalize:doctor:model-retirement",
    );
  });

  it.each(["completed", "failed", "skipped"] as const)(
    "projects historical retirement warnings against a %s receipt",
    (status) => {
      const options = isolatedOptions();
      const { runId } = createUpdateRun(
        { trigger: "cli", after: { version: "2026.11.10" } },
        options,
      );
      const retirementStep = "finalize:doctor:model-retirement";
      const warning =
        status === "completed"
          ? "Deferred model retirement repair completed after plugin convergence."
          : "Model retirement repair still needs attention.";
      recordUpdateRunStep(runId, { step: retirementStep, status }, options);
      recordUpdateRunStep(
        runId,
        { step: `warning:${retirementStep}`, status: "completed", detail: warning },
        options,
      );
      recordUpdateRunStep(
        runId,
        { step: "warning:doctor", status: "completed", detail: "Other repair pending." },
        options,
      );
      const finished = finishUpdateRun(runId, { status: "succeeded" }, options);
      const saved = expectDefined(getUpdateRun(runId, options), "saved update run");
      expect(saved.steps).toEqual(finished.steps);

      const report = renderUpdateRunReport(saved);
      expect(report.headline).toContain(
        status === "completed" ? "1 warning needs attention" : "2 warnings need attention",
      );
      expect(report.lines.filter((line) => line.startsWith("Warning: "))).toEqual(
        status === "completed"
          ? ["Warning: Other repair pending."]
          : ["Warning: " + warning, "Warning: Other repair pending."],
      );
    },
  );
});
