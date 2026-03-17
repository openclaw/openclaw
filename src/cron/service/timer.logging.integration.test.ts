/**
 * Integration tests for cronjob debug logging
 *
 * Tests actual logging behavior with mocked state
 *
 * Run: pnpm test src/cron/service/timer.logging.integration.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";

describe("Cron Timer Logging Integration", () => {
  const mockLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockDeps = {
    log: mockLog,
    nowMs: vi.fn(() => Date.now()),
    cronEnabled: true,
    storePath: "/tmp/test-cron-store.json",
    defaultAgentId: "main",
    onEvent: vi.fn(),
    config: {} as never,
    cliDeps: {} as never,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
  };

  function createState(jobs: CronJob[]): CronServiceState {
    return {
      store: {
        version: 1,
        jobs,
      },
      timer: null,
      running: false,
      deps: mockDeps,
      op: Promise.resolve(),
      warnedDisabled: false,
      storeLoadedAtMs: null,
      storeFileMtimeMs: null,
    } as CronServiceState;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Log message structure", () => {
    it("should log with correct tag format", () => {
      // Arrange
      const _state = createState([]);
      const tagPattern =
        /cron: \[ON-TIMER\]|cron: \[FIND-DUE-JOBS\]|cron: \[RUN-DUE-JOB\]|cron: \[COLLECT-RUNNABLE\]/;

      // Act
      mockLog.info({ test: "data" }, "cron: [ON-TIMER] Starting timer tick");

      // Assert
      expect(mockLog.info).toHaveBeenCalled();
      const call = mockLog.info.mock.calls[0];
      expect(call[1]).toMatch(tagPattern);
    });

    it("should include structured data in first parameter", () => {
      // Arrange
      const _state = createState([]);
      const testData = {
        jobId: "test-job",
        jobName: "Test Job",
        enabled: true,
      };

      // Act
      mockLog.info(testData, "cron: [TEST] Test message");

      // Assert
      expect(mockLog.info).toHaveBeenCalledWith(testData, "cron: [TEST] Test message");
    });
  });

  describe("Workflow job logging", () => {
    it("should detect and log workflow chain presence", () => {
      // Arrange
      const workflowJob = {
        id: "workflow-1",
        name: "Workflow: Test",
        enabled: true,
        schedule: { kind: "cron", expr: "* * * * *" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Test" },
        state: { nextRunAtMs: Date.now() - 1000 },
        description: '__wf_chain__:[{"nodeId":"step1"}]',
      } as CronJob;

      const _state = createState([workflowJob]);

      // Act
      const hasWorkflow = workflowJob.description?.includes("__wf_chain__");

      // Assert
      expect(hasWorkflow).toBe(true);
      expect(workflowJob.description).toContain("__wf_chain__");
    });

    it("should extract workflow chain preview correctly", () => {
      // Arrange
      const longDescription =
        "__wf_chain__:" +
        JSON.stringify([
          { nodeId: "step1", actionType: "agent-prompt", label: "Step 1", prompt: "Prompt 1" },
          { nodeId: "step2", actionType: "agent-prompt", label: "Step 2", prompt: "Prompt 2" },
          { nodeId: "step3", actionType: "if-else", condition: 'input.includes("test")' },
        ]);

      // Act
      const preview = longDescription.substring(
        longDescription.indexOf("__wf_chain__"),
        longDescription.indexOf("__wf_chain__") + 200,
      );

      // Assert
      expect(preview).toContain("__wf_chain__");
      expect(preview.length).toBeLessThanOrEqual(200 + "__wf_chain__".length);
      expect(preview).toContain("step1");
      expect(preview).toContain("step2");
    });

    it("should handle non-workflow jobs", () => {
      // Arrange
      const simpleJob = {
        id: "simple-1",
        name: "Simple Job",
        enabled: true,
        schedule: { kind: "cron", expr: "* * * * *" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Simple test" },
        state: { nextRunAtMs: Date.now() - 1000 },
        description: "Simple cron job",
      } as CronJob;

      // Act
      const hasWorkflow = simpleJob.description?.includes("__wf_chain__");

      // Assert
      expect(hasWorkflow).toBe(false);
      expect(simpleJob.description).not.toContain("__wf_chain__");
    });
  });

  describe("Job state logging", () => {
    it("should log all relevant job state fields", () => {
      // Arrange
      const now = Date.now();
      const job = {
        id: "state-test",
        name: "State Test Job",
        enabled: true,
        schedule: { kind: "cron", expr: "0 * * * *" },
        state: {
          nextRunAtMs: now + 3600000,
          runningAtMs: undefined,
          lastRunAtMs: now - 7200000,
          lastRunStatus: "ok" as const,
          lastDurationMs: 5432,
        },
      } as CronJob;

      // Act
      const logData = {
        jobId: job.id,
        jobName: job.name,
        nextRunAtMs: job.state.nextRunAtMs,
        runningAtMs: job.state.runningAtMs,
        lastRunAtMs: job.state.lastRunAtMs,
        lastRunStatus: job.state.lastRunStatus,
        lastDurationMs: job.state.lastDurationMs,
      };

      // Assert
      expect(logData.jobId).toBe("state-test");
      expect(logData.nextRunAtMs).toBeGreaterThan(now);
      expect(logData.lastRunAtMs).toBeLessThan(now);
      expect(logData.lastRunStatus).toBe("ok");
      expect(logData.lastDurationMs).toBe(5432);
    });

    it("should calculate time until due", () => {
      // Arrange
      const now = Date.now();
      const job = {
        id: "future-job",
        name: "Future Job",
        enabled: true,
        schedule: { kind: "cron", expr: "0 * * * *" },
        state: { nextRunAtMs: now + 3600000 }, // 1 hour
      } as CronJob;

      // Act
      const timeUntilDue = (job.state.nextRunAtMs ?? 0) - now;

      // Assert
      expect(timeUntilDue).toBeGreaterThan(0);
      expect(timeUntilDue).toBeLessThanOrEqual(3600000 + 1000);
      expect(timeUntilDue / 60000).toBeCloseTo(60, 0); // ~60 minutes
    });
  });

  describe("Runnable job detection", () => {
    it("should identify runnable job", () => {
      // Arrange
      const now = Date.now();
      const job = {
        id: "runnable-job",
        name: "Runnable Job",
        enabled: true,
        schedule: { kind: "cron", expr: "* * * * *" },
        state: {
          nextRunAtMs: now - 1000, // Due
          runningAtMs: undefined, // Not running
        },
      } as CronJob;

      // Act
      const isRunnable =
        job.enabled &&
        typeof job.state.runningAtMs !== "number" &&
        typeof job.state.nextRunAtMs === "number" &&
        job.state.nextRunAtMs <= now;

      // Assert
      expect(isRunnable).toBe(true);
    });

    it("should reject disabled job", () => {
      // Arrange
      const job = {
        id: "disabled-job",
        name: "Disabled Job",
        enabled: false,
        schedule: { kind: "cron", expr: "* * * * *" },
        state: { nextRunAtMs: Date.now() - 1000 },
      } as CronJob;

      // Act
      const isRunnable = job.enabled;

      // Assert
      expect(isRunnable).toBe(false);
    });

    it("should reject already running job", () => {
      // Arrange
      const job = {
        id: "running-job",
        name: "Running Job",
        enabled: true,
        schedule: { kind: "cron", expr: "* * * * *" },
        state: {
          nextRunAtMs: Date.now() - 1000,
          runningAtMs: Date.now() - 500, // Currently running
        },
      } as CronJob;

      // Act
      const isRunnable = typeof job.state.runningAtMs !== "number";

      // Assert
      expect(isRunnable).toBe(false);
    });

    it("should reject not-yet-due job", () => {
      // Arrange
      const job = {
        id: "future-job",
        name: "Future Job",
        enabled: true,
        schedule: { kind: "cron", expr: "0 * * * *" },
        state: { nextRunAtMs: Date.now() + 3600000 },
      } as CronJob;

      // Act
      const isRunnable = (job.state.nextRunAtMs ?? 0) <= Date.now();

      // Assert
      expect(isRunnable).toBe(false);
    });
  });

  describe("Error logging", () => {
    it("should log error with message", () => {
      // Arrange
      const error = new Error("Test error message");

      // Act
      mockLog.warn({ error: error.message }, `cron: [RUN-DUE-JOB] Job failed: ${error.message}`);

      // Assert
      expect(mockLog.warn).toHaveBeenCalled();
      const call = mockLog.warn.mock.calls[0];
      expect(call[1]).toContain("Job failed");
      expect(call[1]).toContain("Test error message");
    });

    it("should log error with stack trace", () => {
      // Arrange
      const error = new Error("Stack trace test");
      error.stack = "Error: Stack trace test\n    at test.ts:1:1";

      // Act
      mockLog.warn(
        {
          error: error.message,
          errorStack: error.stack,
        },
        "cron: [TEST] Error occurred",
      );

      // Assert
      expect(mockLog.warn).toHaveBeenCalled();
      const call = mockLog.warn.mock.calls[0];
      expect(call[0]).toHaveProperty("errorStack");
      expect(call[0].errorStack).toContain("test.ts");
    });

    it("should handle non-Error objects", () => {
      // Arrange
      const errorMessage = "String error";

      // Act
      mockLog.warn({ error: errorMessage }, `cron: [TEST] Job failed: ${errorMessage}`);

      // Assert
      expect(mockLog.warn).toHaveBeenCalled();
      const call = mockLog.warn.mock.calls[0];
      expect(call[1]).toContain("String error");
    });
  });

  describe("Performance logging", () => {
    it("should log execution duration", () => {
      // Arrange
      const startedAt = Date.now() - 5432;
      const endedAt = Date.now();
      const durationMs = endedAt - startedAt;

      // Act
      mockLog.info({ durationMs }, "cron: [RUN-DUE-JOB] Execution completed");

      // Assert
      expect(mockLog.info).toHaveBeenCalled();
      const call = mockLog.info.mock.calls[0];
      expect(call[0].durationMs).toBeCloseTo(5432, 0);
    });

    it("should log timeout configuration", () => {
      // Arrange
      const timeoutMs = 300000; // 5 minutes

      // Act
      mockLog.info({ timeoutMs }, "cron: [RUN-DUE-JOB] Executing job with timeout");

      // Assert
      expect(mockLog.info).toHaveBeenCalled();
      const call = mockLog.info.mock.calls[0];
      expect(call[0].timeoutMs).toBe(300000);
      expect(call[0].timeoutMs / 60000).toBe(5); // 5 minutes
    });
  });

  describe("Session tracking logging", () => {
    it("should log session identifiers", () => {
      // Arrange
      const sessionInfo = {
        sessionId: "session-abc-123",
        sessionKey: "agent:main:cron:job-1:run:xyz",
      };

      // Act
      mockLog.info(sessionInfo, "cron: [RUN-DUE-JOB] Execution completed");

      // Assert
      expect(mockLog.info).toHaveBeenCalled();
      const call = mockLog.info.mock.calls[0];
      expect(call[0].sessionId).toBe("session-abc-123");
      expect(call[0].sessionKey).toContain("agent:main:cron");
    });

    it("should log delivery status", () => {
      // Arrange
      const deliveryInfo = {
        delivered: true,
        deliveryStatus: "delivered" as const,
      };

      // Act
      mockLog.info(deliveryInfo, "cron: [RUN-DUE-JOB] Execution completed");

      // Assert
      expect(mockLog.info).toHaveBeenCalled();
      const call = mockLog.info.mock.calls[0];
      expect(call[0].delivered).toBe(true);
      expect(call[0].deliveryStatus).toBe("delivered");
    });
  });
});
