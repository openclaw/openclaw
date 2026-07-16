// Unit coverage for the active-job accounting the heartbeat busy guard depends on.
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCronJobActive,
  hasActiveCronJobs,
  hasActiveCronJobsExcept,
  markCronJobActive,
  resetCronActiveJobs,
} from "./active-jobs.js";

afterEach(() => {
  resetCronActiveJobs();
});

describe("hasActiveCronJobsExcept", () => {
  it("discounts only the named job's own marker", () => {
    markCronJobActive("nightly-report");

    expect(hasActiveCronJobs()).toBe(true);
    expect(hasActiveCronJobsExcept("nightly-report")).toBe(false);
  });

  it("still reports busy while an unrelated job is active", () => {
    markCronJobActive("nightly-report");
    markCronJobActive("different-job");

    // The owning job must not be waved through while another run holds a marker:
    // cron executes jobs concurrently (cron.maxConcurrentRuns).
    expect(hasActiveCronJobsExcept("nightly-report")).toBe(true);
  });

  it("reports idle once the unrelated job clears", () => {
    markCronJobActive("nightly-report");
    const otherMarker = markCronJobActive("different-job");
    clearCronJobActive("different-job", otherMarker);

    expect(hasActiveCronJobsExcept("nightly-report")).toBe(false);
  });

  it("falls back to the plain busy check when no job id is given", () => {
    markCronJobActive("nightly-report");

    expect(hasActiveCronJobsExcept("")).toBe(true);
  });
});
