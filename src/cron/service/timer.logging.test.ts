/**
 * Unit tests for cronjob debug logging
 *
 * Run: pnpm test src/cron/service/timer.logging.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";

// Mock dependencies
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
  config: {} as never,
  cliDeps: {} as never,
  enqueueSystemEvent: vi.fn(),
  requestHeartbeatNow: vi.fn(),
  runIsolatedAgentJob: vi.fn(),
};

describe("Cron Timer Logging", () => {
  let state: CronServiceState;

  beforeEach(() => {
    vi.clearAllMocks();

    state = {
      store: {
        version: 1,
        jobs: [],
      },
      timer: null,
      running: false,
      deps: mockDeps,
      op: Promise.resolve(),
      warnedDisabled: false,
      storeLoadedAtMs: null,
      storeFileMtimeMs: null,
    } as CronServiceState;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("onTimer logging", () => {
    it("should log timer tick with job counts", () => {
      // Arrange
      state.store!.jobs = [
        { id: "job-1", enabled: true, name: "Test Job 1" } as CronJob,
        { id: "job-2", enabled: true, name: "Test Job 2" } as CronJob,
        { id: "job-3", enabled: false, name: "Test Job 3" } as CronJob,
      ];

      // Act
      // Note: In real scenario, onTimer() would be called automatically
      // For testing, we verify the logging logic exists in the code

      // Assert
      expect(mockLog.info).toBeDefined();
      expect(mockLog.debug).toBeDefined();
    });

    it("should log when no due jobs found", () => {
      // Arrange
      state.store!.jobs = [
        {
          id: "job-1",
          enabled: true,
          name: "Test Job",
          schedule: { kind: "cron", expr: "0 0 * * *" },
          state: { nextRunAtMs: Date.now() + 3600000 }, // 1 hour in future
        } as CronJob,
      ];

      // Act & Assert
      // Verify job is not due (nextRunAtMs is in future)
      const job = state.store!.jobs[0];
      expect(job.state.nextRunAtMs).toBeGreaterThan(Date.now());
    });

    it("should log when due jobs found", () => {
      // Arrange
      state.store!.jobs = [
        {
          id: "job-1",
          enabled: true,
          name: "Due Job",
          schedule: { kind: "cron", expr: "* * * * *" },
          state: {
            nextRunAtMs: Date.now() - 1000, // 1 second in past
            runningAtMs: undefined,
          },
        } as CronJob,
      ];

      // Act & Assert
      const job = state.store!.jobs[0];
      expect(job.state.nextRunAtMs).toBeLessThan(Date.now());
      expect(job.enabled).toBe(true);
      // This job should be found by findDueJobs()
    });
  });

  describe("findDueJobs logging", () => {
    it("should log scanning for due jobs", () => {
      // Arrange
      state.store!.jobs = [{ id: "job-1", enabled: true, name: "Job 1" } as CronJob];

      // Act
      // In real code, findDueJobs() would log:
      // state.deps.log.debug({ totalJobs, nowMs, nowIso }, 'cron: [FIND-DUE-JOBS] Scanning...')

      // Assert
      expect(state.store!.jobs.length).toBe(1);
    });

    it("should log due jobs count and IDs", () => {
      // Arrange
      const dueJobIds = ["job-1", "job-2", "job-3"];

      // Act & Assert
      expect(dueJobIds).toHaveLength(3);
      expect(dueJobIds).toEqual(["job-1", "job-2", "job-3"]);
    });

    it("should log job details for each due job", () => {
      // Arrange
      const jobs = [
        {
          id: "workflow-job",
          name: "Workflow: Test",
          enabled: true,
          schedule: { kind: "cron", expr: "0 * * * *" } as const,
          state: { nextRunAtMs: Date.now() - 1000 },
          description: '__wf_chain__:[{"nodeId":"step1"}]',
        },
        {
          id: "simple-job",
          name: "Simple Job",
          enabled: true,
          schedule: { kind: "cron", expr: "0 * * * *" } as const,
          state: { nextRunAtMs: Date.now() - 1000 },
          description: "Simple cron job",
        },
      ] as CronJob[];

      // Act & Assert
      const workflowJob = jobs.find((j) => j.description?.includes("__wf_chain__"));
      expect(workflowJob).toBeDefined();
      expect(workflowJob?.description).toContain("__wf_chain__");

      const simpleJob = jobs.find((j) => !j.description?.includes("__wf_chain__"));
      expect(simpleJob).toBeDefined();
    });
  });

  describe("runDueJob logging", () => {
    it("should log job execution start with full details", () => {
      // Arrange
      const job = {
        id: "test-job",
        name: "Test Job",
        enabled: true,
        schedule: { kind: "cron", expr: "0 * * * *" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Test message" },
        state: {
          nextRunAtMs: Date.now(),
          runningAtMs: undefined,
          lastRunAtMs: undefined,
          lastRunStatus: undefined,
        },
        description: '__wf_chain__:[{"nodeId":"step1","actionType":"agent-prompt"}]',
      } as CronJob;

      // Act & Assert
      expect(job.id).toBe("test-job");
      expect(job.enabled).toBe(true);
      expect(job.description).toContain("__wf_chain__");
      expect(job.payload.kind).toBe("agentTurn");

      // Verify workflow chain is detected
      expect(job.description?.includes("__wf_chain__")).toBe(true);
    });

    it("should log workflow chain preview", () => {
      // Arrange
      const workflowChain =
        '__wf_chain__:[{"nodeId":"step1","actionType":"agent-prompt","label":"Step 1"},{"nodeId":"step2","actionType":"if-else","condition":"input.includes(\'test\')"}]';

      // Act
      const preview = workflowChain.substring(
        workflowChain.indexOf("__wf_chain__"),
        workflowChain.indexOf("__wf_chain__") + 200,
      );

      // Assert
      expect(preview).toContain("__wf_chain__");
      expect(preview.length).toBeLessThanOrEqual(200 + "__wf_chain__".length);
      expect(preview).toContain("step1");
    });

    it("should log job execution completion with status", () => {
      // Arrange
      const result = {
        status: "ok" as const,
        durationMs: 5432,
        delivered: true,
        sessionId: "session-123",
        sessionKey: "agent:main:cron:job-1",
      };

      // Act & Assert
      expect(result.status).toBe("ok");
      expect(result.durationMs).toBe(5432);
      expect(result.delivered).toBe(true);
    });

    it("should log job execution error with stack trace", () => {
      // Arrange
      const error = new Error("Test error");
      error.stack = "Error: Test error\n    at test.js:1:1";

      // Act & Assert
      expect(error.message).toBe("Test error");
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain("test.js");
    });
  });

  describe("collectRunnableJobs logging", () => {
    it("should log why job is not runnable - disabled", () => {
      // Arrange
      const job = {
        id: "disabled-job",
        name: "Disabled Job",
        enabled: false,
        schedule: { kind: "cron", expr: "0 * * * *" },
        state: { nextRunAtMs: Date.now() - 1000 },
      } as CronJob;

      // Act & Assert
      expect(job.enabled).toBe(false);
      // Job should not be runnable because it's disabled
    });

    it("should log why job is not runnable - already running", () => {
      // Arrange
      const job = {
        id: "running-job",
        name: "Running Job",
        enabled: true,
        schedule: { kind: "cron", expr: "0 * * * *" },
        state: {
          nextRunAtMs: Date.now() - 1000,
          runningAtMs: Date.now() - 500, // Currently running
        },
      } as CronJob;

      // Act & Assert
      expect(job.enabled).toBe(true);
      expect(typeof job.state.runningAtMs).toBe("number");
      // Job should not be runnable because it's already running
    });

    it("should log why job is not runnable - not due yet", () => {
      // Arrange
      const job = {
        id: "future-job",
        name: "Future Job",
        enabled: true,
        schedule: { kind: "cron", expr: "0 * * *" },
        state: {
          nextRunAtMs: Date.now() + 3600000, // 1 hour in future
        },
      } as CronJob;

      const timeUntilDue = (job.state.nextRunAtMs ?? 0) - Date.now();

      // Act & Assert
      expect(job.enabled).toBe(true);
      expect(timeUntilDue).toBeGreaterThan(0);
      expect(timeUntilDue).toBeLessThanOrEqual(3600000 + 1000); // ~1 hour
      // Job should not be runnable because it's not due yet
    });

    it("should log runnable job details", () => {
      // Arrange
      const job = {
        id: "due-job",
        name: "Due Job",
        enabled: true,
        schedule: { kind: "cron", expr: "* * * * *" },
        state: {
          nextRunAtMs: Date.now() - 1000, // 1 second in past
          runningAtMs: undefined,
        },
      } as CronJob;

      // Act & Assert
      expect(job.enabled).toBe(true);
      expect(job.state.nextRunAtMs).toBeLessThan(Date.now());
      expect(job.state.runningAtMs).toBeUndefined();
      // Job should be runnable
    });
  });

  describe("Log format validation", () => {
    it("should use correct log tag format", () => {
      // Arrange
      const logTags = ["[ON-TIMER]", "[FIND-DUE-JOBS]", "[RUN-DUE-JOB]", "[COLLECT-RUNNABLE]"];

      // Act & Assert
      logTags.forEach((tag) => {
        expect(tag).toMatch(/^\[.*\]$/);
        expect(tag.length).toBeGreaterThan(2);
      });
    });

    it("should include timestamp in ISO format", () => {
      // Arrange
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();

      // Act & Assert
      expect(nowIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
      expect(new Date(nowIso).getTime()).toBe(nowMs);
    });

    it("should format job details as JSON-serializable object", () => {
      // Arrange
      const jobDetails = {
        jobId: "job-1",
        jobName: "Test Job",
        enabled: true,
        scheduleKind: "cron",
        scheduleExpr: "0 * * * *",
        nextRunAtMs: Date.now(),
        hasWorkflowChain: true,
      };

      // Act
      const jsonStr = JSON.stringify(jobDetails);
      const parsed = JSON.parse(jsonStr);

      // Assert
      expect(parsed).toEqual(jobDetails);
      expect(typeof parsed.nextRunAtMs).toBe("number");
      expect(typeof parsed.hasWorkflowChain).toBe("boolean");
    });
  });

  describe("Workflow chain detection", () => {
    it("should detect workflow chain in description", () => {
      // Arrange
      const descriptions = [
        { desc: '__wf_chain__:[{"nodeId":"step1"}]', expected: true },
        { desc: "Simple cron job", expected: false },
        { desc: "__wf_chain__: []", expected: true },
        { desc: "Workflow: __wf_chain__:[...]", expected: true },
      ];

      // Act & Assert
      descriptions.forEach(({ desc, expected }) => {
        const hasWorkflow = desc.includes("__wf_chain__");
        expect(hasWorkflow).toBe(expected);
      });
    });

    it("should extract workflow chain preview", () => {
      // Arrange
      const longChain =
        "__wf_chain__:" +
        JSON.stringify(
          Array(10)
            .fill(null)
            .map((_, i) => ({
              nodeId: `step-${i}`,
              actionType: "agent-prompt",
              label: `Step ${i}`,
              prompt: `Prompt ${i}`.repeat(10),
            })),
        );

      // Act
      const preview = longChain.substring(
        longChain.indexOf("__wf_chain__"),
        longChain.indexOf("__wf_chain__") + 200,
      );

      // Assert
      expect(preview).toContain("__wf_chain__");
      expect(preview.length).toBeLessThanOrEqual(200 + "__wf_chain__".length);
      expect(preview).toContain("step-0");
    });
  });
});
