import { describe, expect, it } from "vitest";
import {
  isJobStuck,
  formatDuration,
  extractCronJobError,
  calculateCronReliabilityMetrics,
  formatCronReliabilityMetrics,
  cronJobNeedsAttention,
  getCronJobRecommendations,
  resolveStuckThresholdMs,
} from "./reliability.js";
import type { CronJob } from "./types.js";

function createMockJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job-1",
    name: "Test Job",
    enabled: true,
    schedule: { kind: "cron", cron: "0 * * * *" },
    payload: { text: "test" },
    delivery: { channel: "test-channel" },
    state: {
      status: "pending",
      nextRunAtMs: Date.now(),
      ...overrides.state,
    },
    ...overrides,
  } as CronJob;
}

describe("cron reliability", () => {
  describe("resolveStuckThresholdMs", () => {
    it("returns default threshold when not configured", () => {
      expect(resolveStuckThresholdMs()).toBe(2 * 60 * 60 * 1000);
    });

    it("returns configured threshold", () => {
      expect(resolveStuckThresholdMs({ stuckThresholdMs: 60000 })).toBe(60000);
    });
  });

  describe("isJobStuck", () => {
    it("returns false for pending jobs", () => {
      const job = createMockJob({ state: { status: "pending" } });
      expect(isJobStuck(job, Date.now())).toBe(false);
    });

    it("returns false for completed jobs", () => {
      const job = createMockJob({ state: { status: "completed", startedAt: Date.now() - 1000, endedAt: Date.now() } });
      expect(isJobStuck(job, Date.now())).toBe(false);
    });

    it("returns true for running jobs exceeding threshold", () => {
      const job = createMockJob({
        state: {
          status: "running",
          startedAt: Date.now() - (3 * 60 * 60 * 1000), // 3 hours ago
        },
      });
      expect(isJobStuck(job, Date.now())).toBe(true);
    });

    it("returns false for running jobs within threshold", () => {
      const job = createMockJob({
        state: {
          status: "running",
          startedAt: Date.now() - 60000, // 1 minute ago
        },
      });
      expect(isJobStuck(job, Date.now())).toBe(false);
    });
  });

  describe("formatDuration", () => {
    it("formats milliseconds", () => {
      expect(formatDuration(500)).toBe("500ms");
    });

    it("formats seconds", () => {
      expect(formatDuration(5000)).toBe("5.0s");
    });

    it("formats minutes", () => {
      expect(formatDuration(120000)).toBe("2.0m");
    });

    it("formats hours", () => {
      expect(formatDuration(3600000)).toBe("1.0h");
    });
  });

  describe("extractCronJobError", () => {
    it("extracts string error", () => {
      const job = createMockJob({ state: { status: "failed", error: "Something went wrong" } });
      expect(extractCronJobError(job)).toBe("Something went wrong");
    });

    it("extracts error object message", () => {
      const job = createMockJob({ state: { status: "failed", error: { message: "Error object" } } });
      expect(extractCronJobError(job)).toBe("Error object");
    });

    it("returns undefined for successful jobs", () => {
      const job = createMockJob({ state: { status: "completed" } });
      expect(extractCronJobError(job)).toBeUndefined();
    });
  });

  describe("calculateCronReliabilityMetrics", () => {
    it("calculates metrics for empty jobs", () => {
      const metrics = calculateCronReliabilityMetrics([], Date.now());
      expect(metrics.totalJobs).toBe(0);
      expect(metrics.enabledJobs).toBe(0);
    });

    it("calculates metrics with mixed job states", () => {
      const now = Date.now();
      const jobs = [
        createMockJob({ state: { status: "running", startedAt: now - 1000 } }),
        createMockJob({ state: { status: "completed", startedAt: now - 10000, endedAt: now - 5000 } }),
        createMockJob({ state: { status: "failed", error: "failed" } }),
        createMockJob({ enabled: false, state: { status: "pending" } }),
      ];

      const metrics = calculateCronReliabilityMetrics(jobs, now);
      expect(metrics.totalJobs).toBe(4);
      expect(metrics.enabledJobs).toBe(3);
      expect(metrics.runningJobs).toBe(1);
      expect(metrics.failedJobs).toBe(1);
    });

    it("detects stuck jobs", () => {
      const now = Date.now();
      const jobs = [
        createMockJob({
          id: "stuck-job",
          state: {
            status: "running",
            startedAt: now - (3 * 60 * 60 * 1000), // 3 hours ago
          },
        }),
      ];

      const metrics = calculateCronReliabilityMetrics(jobs, now);
      expect(metrics.stuckJobs).toBe(1);
    });
  });

  describe("formatCronReliabilityMetrics", () => {
    it("formats metrics for display", () => {
      const metrics = {
        totalJobs: 5,
        enabledJobs: 4,
        runningJobs: 1,
        stuckJobs: 0,
        failedJobs: 1,
        averageExecutionTimeMs: 5000,
        lastFailureTime: Date.now() - 3600000,
      };

      const formatted = formatCronReliabilityMetrics(metrics);
      expect(formatted).toContain("Total Jobs: 5");
      expect(formatted).toContain("Enabled: 4");
      expect(formatted).toContain("Running: 1");
      expect(formatted).toContain("Stuck: 0");
      expect(formatted).toContain("Failed: 1");
      expect(formatted).toContain("Avg Execution Time: 5.0s");
    });
  });

  describe("cronJobNeedsAttention", () => {
    it("returns true for stuck jobs", () => {
      const job = createMockJob({
        state: {
          status: "running",
          startedAt: Date.now() - (3 * 60 * 60 * 1000),
        },
      });
      expect(cronJobNeedsAttention(job, Date.now())).toBe(true);
    });

    it("returns true for failed jobs", () => {
      const job = createMockJob({ state: { status: "failed", error: "error" } });
      expect(cronJobNeedsAttention(job, Date.now())).toBe(true);
    });

    it("returns false for healthy running jobs", () => {
      const job = createMockJob({
        state: {
          status: "running",
          startedAt: Date.now() - 60000,
        },
      });
      expect(cronJobNeedsAttention(job, Date.now())).toBe(false);
    });
  });

  describe("getCronJobRecommendations", () => {
    it("provides recommendations for failed jobs", () => {
      const job = createMockJob({ state: { status: "failed", error: "Timeout error" } });
      const recommendations = getCronJobRecommendations(job);
      expect(recommendations.length).toBeGreaterThan(0);
      expect(recommendations.some((r) => r.includes("Timeout error"))).toBe(true);
    });

    it("provides recommendations for disabled jobs", () => {
      const job = createMockJob({ enabled: false, state: { status: "pending" } });
      const recommendations = getCronJobRecommendations(job);
      expect(recommendations.some((r) => r.includes("disabled"))).toBe(true);
    });
  });
});
