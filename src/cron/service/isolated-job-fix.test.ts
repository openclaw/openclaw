import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CronJobCreate } from "../types.js";
import { CronService } from "../service.js";

describe("CronService isolated job fix", () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };

  const mockDeps = {
    storePath: "/tmp/test-cron.json",
    cronEnabled: true,
    log: mockLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "test" }),
    nowMs: vi.fn(() => Date.now()),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should execute isolated jobs automatically", async () => {
    const service = new CronService(mockDeps);

    try {
      await service.start();

      // Create an isolated job that should run soon
      const now = Date.now();
      const jobInput: CronJobCreate = {
        name: "Test isolated job",
        schedule: { kind: "at", at: new Date(now + 100).toISOString() }, // Run in 100ms
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "Test message" },
      };

      const job = await service.add(jobInput);
      expect(job).toBeDefined();

      // Wait for the job to execute
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify the isolated job was executed
      expect(mockDeps.runIsolatedAgentJob).toHaveBeenCalled();

      const calls = mockDeps.runIsolatedAgentJob.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      // Verify it was called with the correct job
      const callArgs = calls[0][0];
      expect(callArgs.job.id).toBe(job.id);
      expect(callArgs.message).toBe("Test message");
    } finally {
      service.stop();
    }
  });
});
