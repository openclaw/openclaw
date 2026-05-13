import { describe, expect, it } from "vitest";
import { clearCronJobActive, isCronJobActive, markCronJobActive } from "../active-jobs.js";

describe("isCronJobActive / markCronJobActive / clearCronJobActive — issue #81087", () => {
  it("marks a job as active and reports it via isCronJobActive", () => {
    const jobId = "test-job-1";
    clearCronJobActive(jobId);
    expect(isCronJobActive(jobId)).toBe(false);

    markCronJobActive(jobId);
    expect(isCronJobActive(jobId)).toBe(true);

    clearCronJobActive(jobId);
    expect(isCronJobActive(jobId)).toBe(false);
  });

  it("tracks multiple jobs independently", () => {
    const jobA = "job-a";
    const jobB = "job-b";

    clearCronJobActive(jobA);
    clearCronJobActive(jobB);

    markCronJobActive(jobA);
    expect(isCronJobActive(jobA)).toBe(true);
    expect(isCronJobActive(jobB)).toBe(false);

    markCronJobActive(jobB);
    expect(isCronJobActive(jobA)).toBe(true);
    expect(isCronJobActive(jobB)).toBe(true);

    clearCronJobActive(jobA);
    expect(isCronJobActive(jobA)).toBe(false);
    expect(isCronJobActive(jobB)).toBe(true);

    clearCronJobActive(jobB);
    expect(isCronJobActive(jobB)).toBe(false);
  });

  it("idempotent: marking active twice is safe", () => {
    const jobId = "idempotent-job";
    clearCronJobActive(jobId);

    markCronJobActive(jobId);
    markCronJobActive(jobId);
    expect(isCronJobActive(jobId)).toBe(true);

    clearCronJobActive(jobId);
    expect(isCronJobActive(jobId)).toBe(false);
  });
});
