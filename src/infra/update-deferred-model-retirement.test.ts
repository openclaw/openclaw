import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  hasDeferredUpdateModelRetirement,
  recordUpdateModelRetirement,
} from "./update-deferred-model-retirement.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import { updateRunWarningMessages } from "./update-run-step.js";

it("names the package-convergence blocker and retires its warning after durable repair", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
    const env = { ...state.env, OPENCLAW_UPDATE_RUN_ID: run.runId };
    recordUpdateModelRetirement("deferred", env);
    expect(hasDeferredUpdateModelRetirement(env)).toBe(true);
    expect(updateRunWarningMessages(getUpdateRun(run.runId, { env })!.steps)).toEqual([
      expect.stringContaining("the updating parent still owns plugin installation"),
    ]);
    recordUpdateModelRetirement("completed", env);
    expect(hasDeferredUpdateModelRetirement(env)).toBe(false);
    expect(updateRunWarningMessages(getUpdateRun(run.runId, { env })!.steps)).toEqual([
      "Deferred model retirement repair completed after plugin convergence.",
    ]);
  });
});
