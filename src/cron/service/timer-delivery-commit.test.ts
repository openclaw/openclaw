import { describe, expect, it } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronCompletionStatus } from "../types.js";
import { applyScriptRunResult } from "./timer-outcomes.js";
import { applyTriggerRunResult } from "./timer-trigger.js";

describe("cron state after required delivery", () => {
  it.each(["failed", "unknown", "succeeded"] as const)(
    "commits trigger state and disarms once only for %s completion",
    (completionStatus: CronCompletionStatus) => {
      const job = makeCronJob({
        trigger: { script: "json({fire:true})", once: true },
        state: { triggerState: { cursor: "old" } },
      });
      applyTriggerRunResult(job, {
        status: "ok",
        completionStatus,
        endedAt: 123,
        triggerEval: { fired: true, stateChanged: true, state: { cursor: "new" } },
      });

      expect(job.state.triggerState).toEqual({
        cursor: completionStatus === "succeeded" ? "new" : "old",
      });
      expect(job.enabled).toBe(completionStatus !== "succeeded");
    },
  );

  it.each(["failed", "unknown", "succeeded"] as const)(
    "commits payload-script state only for %s completion",
    (completionStatus: CronCompletionStatus) => {
      const job = makeCronJob({ state: { triggerState: { cursor: "old" } } });
      applyScriptRunResult(job, {
        status: "ok",
        completionStatus,
        scriptStateChanged: true,
        scriptState: { cursor: "new" },
      });
      expect(job.state.triggerState).toEqual({
        cursor: completionStatus === "succeeded" ? "new" : "old",
      });
    },
  );
});
