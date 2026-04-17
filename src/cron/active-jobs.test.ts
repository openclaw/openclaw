import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCronJobActive,
  isCronJobActive,
  markCronJobActive,
  resetCronActiveJobsForTests,
} from "./active-jobs.js";

describe("active-jobs", () => {
  beforeEach(() => {
    resetCronActiveJobsForTests();
  });

  describe("markCronJobActive + isCronJobActive", () => {
    it("records a job as active", () => {
      expect(isCronJobActive("job-1")).toBe(false);
      markCronJobActive("job-1");
      expect(isCronJobActive("job-1")).toBe(true);
    });

    it("is idempotent when the same jobId is marked repeatedly", () => {
      markCronJobActive("job-1");
      markCronJobActive("job-1");
      markCronJobActive("job-1");
      expect(isCronJobActive("job-1")).toBe(true);
    });

    it("keeps each job's active state independent", () => {
      markCronJobActive("job-a");
      markCronJobActive("job-b");
      expect(isCronJobActive("job-a")).toBe(true);
      expect(isCronJobActive("job-b")).toBe(true);
      expect(isCronJobActive("job-c")).toBe(false);
    });

    it("ignores an empty jobId on mark", () => {
      markCronJobActive("");
      expect(isCronJobActive("")).toBe(false);
    });

    it("returns false for an empty jobId on query", () => {
      markCronJobActive("job-1");
      expect(isCronJobActive("")).toBe(false);
    });
  });

  describe("clearCronJobActive", () => {
    it("removes a previously-active job", () => {
      markCronJobActive("job-1");
      clearCronJobActive("job-1");
      expect(isCronJobActive("job-1")).toBe(false);
    });

    it("is a no-op when the job was never marked", () => {
      expect(() => clearCronJobActive("unknown")).not.toThrow();
      expect(isCronJobActive("unknown")).toBe(false);
    });

    it("only clears the targeted jobId", () => {
      markCronJobActive("job-a");
      markCronJobActive("job-b");
      clearCronJobActive("job-a");
      expect(isCronJobActive("job-a")).toBe(false);
      expect(isCronJobActive("job-b")).toBe(true);
    });

    it("ignores an empty jobId", () => {
      markCronJobActive("job-1");
      clearCronJobActive("");
      expect(isCronJobActive("job-1")).toBe(true);
    });
  });

  describe("resetCronActiveJobsForTests", () => {
    it("clears all tracked jobs", () => {
      markCronJobActive("job-a");
      markCronJobActive("job-b");
      markCronJobActive("job-c");
      resetCronActiveJobsForTests();
      expect(isCronJobActive("job-a")).toBe(false);
      expect(isCronJobActive("job-b")).toBe(false);
      expect(isCronJobActive("job-c")).toBe(false);
    });

    it("is a no-op when no jobs are tracked", () => {
      expect(() => resetCronActiveJobsForTests()).not.toThrow();
    });
  });
});
