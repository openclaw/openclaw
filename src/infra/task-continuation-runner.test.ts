import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startTaskContinuationRunner, __resetAgentStates } from "./task-continuation-runner.js";

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/test-workspace"),
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

vi.mock("../agents/tools/task-tool.js", () => ({
  findActiveTask: vi.fn(),
  findPendingTasks: vi.fn(),
  findPickableBacklogTask: vi.fn(),
  findBlockedTasks: vi.fn(),
  findPendingApprovalTasks: vi.fn(),
  findAllBacklogTasks: vi.fn(),
  writeTask: vi.fn(),
  readTask: vi.fn(),
}));

vi.mock("../commands/agent.js", () => ({
  agentCommand: vi.fn(),
}));

vi.mock("./task-lock.js", () => ({
  acquireTaskLock: vi.fn(async () => ({ release: vi.fn() })),
}));

vi.mock("../routing/bindings.js", () => ({
  resolveAgentBoundAccountId: vi.fn(() => "test-account"),
}));

vi.mock("../agents/tools/sessions-helpers.js", () => ({
  createAgentToAgentPolicy: vi.fn(() => ({ isAllowed: () => true })),
}));

vi.mock("../process/command-queue.js", () => ({
  getQueueSize: vi.fn(() => 0),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  },
}));

import {
  findActiveTask,
  findPendingTasks,
  findPickableBacklogTask,
  findBlockedTasks,
  findPendingApprovalTasks,
  readTask,
} from "../agents/tools/task-tool.js";
import { agentCommand } from "../commands/agent.js";
import { getQueueSize } from "../process/command-queue.js";

describe("startTaskContinuationRunner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T10:00:00Z"));
    vi.clearAllMocks();
    __resetAgentStates();
    vi.mocked(findActiveTask).mockResolvedValue(null);
    vi.mocked(findPendingTasks).mockResolvedValue([]);
    vi.mocked(findPendingApprovalTasks).mockResolvedValue([]);
    vi.mocked(findPickableBacklogTask).mockResolvedValue(null);
    vi.mocked(findBlockedTasks).mockResolvedValue([]);
    vi.mocked(readTask).mockResolvedValue(null);
    vi.mocked(agentCommand).mockResolvedValue({
      text: "ok",
      sessionId: "test",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    vi.mocked(getQueueSize).mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts and stops without error", () => {
    const runner = startTaskContinuationRunner({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });
    expect(runner).toBeDefined();
    runner.stop();
  });

  it("does not send prompt when no active task", async () => {
    vi.mocked(findActiveTask).mockResolvedValue(null);

    const runner = startTaskContinuationRunner({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(agentCommand).not.toHaveBeenCalled();
    runner.stop();
  });

  it("sends continuation prompt for idle task", async () => {
    const idleTask = {
      id: "task_abc123",
      status: "in_progress" as const,
      priority: "high" as const,
      description: "Fix the bug",
      created: "2026-02-05T09:50:00Z",
      lastActivity: "2026-02-05T09:50:00Z",
      progress: ["Started"],
    };
    vi.mocked(findActiveTask).mockResolvedValue(idleTask);
    vi.mocked(findPendingTasks).mockResolvedValue([]);

    const runner = startTaskContinuationRunner({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("TASK CONTINUATION"),
        agentId: "main",
        deliver: false,
      }),
    );
    runner.stop();
  });

  it("tells non-simple step-less tasks to define steps before continuing", async () => {
    const idleTask = {
      id: "task_complex123",
      status: "in_progress" as const,
      priority: "high" as const,
      description: "Investigate and fix contract mismatch",
      created: "2026-02-05T09:50:00Z",
      lastActivity: "2026-02-05T09:50:00Z",
      progress: ["Task started"],
    };
    vi.mocked(findActiveTask).mockResolvedValue(idleTask);

    const runner = startTaskContinuationRunner({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(3 * 60_000);

    const message = vi.mocked(agentCommand).mock.calls[0][0].message;
    expect(message).toContain('action: "set_steps"');
    expect(message).toContain('task_id: "task_complex123"');
    expect(message).toContain("Before continuing");

    runner.stop();
  });

  it("respects cooldown between prompts", async () => {
    const idleTask = {
      id: "task_abc123",
      status: "in_progress" as const,
      priority: "high" as const,
      description: "Fix the bug",
      created: "2026-02-05T09:50:00Z",
      lastActivity: "2026-02-05T09:50:00Z",
      progress: ["Started"],
    };
    vi.mocked(findActiveTask).mockResolvedValue(idleTask);

    const runner = startTaskContinuationRunner({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(agentCommand).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(agentCommand).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(agentCommand).toHaveBeenCalledTimes(2);

    runner.stop();
  });

  it("skips when agent is busy", async () => {
    vi.mocked(getQueueSize).mockReturnValue(1);
    const idleTask = {
      id: "task_abc123",
      status: "in_progress" as const,
      priority: "high" as const,
      description: "Fix the bug",
      created: "2026-02-05T09:50:00Z",
      lastActivity: "2026-02-05T09:50:00Z",
      progress: ["Started"],
    };
    vi.mocked(findActiveTask).mockResolvedValue(idleTask);

    const runner = startTaskContinuationRunner({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(agentCommand).not.toHaveBeenCalled();
    runner.stop();
  });

  it("respects disabled config", async () => {
    const idleTask = {
      id: "task_abc123",
      status: "in_progress" as const,
      priority: "high" as const,
      description: "Fix the bug",
      created: "2026-02-05T09:50:00Z",
      lastActivity: "2026-02-05T09:50:00Z",
      progress: ["Started"],
    };
    vi.mocked(findActiveTask).mockResolvedValue(idleTask);

    const runner = startTaskContinuationRunner({
      cfg: {
        agents: { defaults: { taskContinuation: { enabled: false } } },
      } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(agentCommand).not.toHaveBeenCalled();
    runner.stop();
  });

  it("updates config dynamically", async () => {
    const idleTask = {
      id: "task_abc123",
      status: "in_progress" as const,
      priority: "high" as const,
      description: "Fix the bug",
      created: "2026-02-05T09:50:00Z",
      lastActivity: "2026-02-05T09:50:00Z",
      progress: ["Started"],
    };
    vi.mocked(findActiveTask).mockResolvedValue(idleTask);

    const runner = startTaskContinuationRunner({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    runner.updateConfig({
      agents: { defaults: { taskContinuation: { enabled: false } } },
    } as OpenClawConfig);

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(agentCommand).not.toHaveBeenCalled();
    runner.stop();
  });

  it("skips tasks with pending_approval status", async () => {
    const pendingApprovalTask = {
      id: "task_pending123",
      status: "pending_approval" as const,
      priority: "high" as const,
      description: "Task awaiting approval",
      created: "2026-02-05T09:50:00Z",
      lastActivity: "2026-02-05T09:50:00Z",
      progress: ["Task created - awaiting approval"],
    };
    vi.mocked(findActiveTask).mockResolvedValue(pendingApprovalTask);

    const runner = startTaskContinuationRunner({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(agentCommand).not.toHaveBeenCalled();
    runner.stop();
  });

  describe("failure-based backoff", () => {
    const idleTask = {
      id: "task_abc123",
      status: "in_progress" as const,
      priority: "high" as const,
      description: "Fix the bug",
      created: "2026-02-05T09:50:00Z",
      lastActivity: "2026-02-05T09:50:00Z",
      progress: ["Started"],
    };

    it("applies 1 minute backoff for rate_limit errors", async () => {
      vi.mocked(findActiveTask).mockResolvedValue(idleTask);
      vi.mocked(agentCommand).mockRejectedValue(new Error("All models failed: rate_limit"));

      const runner = startTaskContinuationRunner({
        cfg: { agents: { defaults: {} } } as OpenClawConfig,
      });

      // First attempt at T+2min (check interval) - task is idle (>3min since lastActivity at T-10min)
      // Fails with rate_limit -> 1 minute backoff
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(agentCommand).toHaveBeenCalled();

      // Reset mock to track new calls
      vi.mocked(agentCommand).mockClear();

      // Next check at T+4min - backoff expired (1min backoff from T+2 = T+3), retry
      // Fails again -> 2 minute backoff (exponential: 1min * 2^1)
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(agentCommand).toHaveBeenCalled();

      runner.stop();
    });

    it("applies 1 hour backoff for billing errors", async () => {
      vi.mocked(findActiveTask).mockResolvedValue(idleTask);
      vi.mocked(agentCommand).mockRejectedValue(new Error("billing error: insufficient credits"));

      const runner = startTaskContinuationRunner({
        cfg: { agents: { defaults: {} } } as OpenClawConfig,
      });

      // First attempt - fails with billing
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(agentCommand).toHaveBeenCalled();

      vi.mocked(agentCommand).mockClear();

      // After 30 minutes - still in backoff (1hr required)
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(agentCommand).not.toHaveBeenCalled();

      // After 60 minutes total - backoff expired
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(agentCommand).toHaveBeenCalled();

      runner.stop();
    });

    it("applies 1 minute backoff for timeout errors", async () => {
      vi.mocked(findActiveTask).mockResolvedValue(idleTask);
      vi.mocked(agentCommand).mockRejectedValue(new Error("request timeout"));

      const runner = startTaskContinuationRunner({
        cfg: { agents: { defaults: {} } } as OpenClawConfig,
      });

      // First attempt - fails with timeout
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(agentCommand).toHaveBeenCalled();

      vi.mocked(agentCommand).mockClear();

      // After 1 minute - backoff expired, should retry
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(agentCommand).toHaveBeenCalled();

      runner.stop();
    });

    it("applies 5 minute backoff for unknown errors", async () => {
      vi.mocked(findActiveTask).mockResolvedValue(idleTask);
      vi.mocked(agentCommand).mockRejectedValue(new Error("some random error"));

      const runner = startTaskContinuationRunner({
        cfg: { agents: { defaults: {} } } as OpenClawConfig,
      });

      // First attempt - fails with unknown
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(agentCommand).toHaveBeenCalled();

      vi.mocked(agentCommand).mockClear();

      // After 3 minutes - still in backoff (5min required)
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(agentCommand).not.toHaveBeenCalled();

      // After 5 minutes total - backoff expired
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(agentCommand).toHaveBeenCalled();

      runner.stop();
    });

    it("applies exponential backoff on consecutive failures", async () => {
      vi.mocked(findActiveTask).mockResolvedValue(idleTask);
      vi.mocked(agentCommand).mockRejectedValue(new Error("rate_limit"));

      const runner = startTaskContinuationRunner({
        cfg: { agents: { defaults: {} } } as OpenClawConfig,
      });

      // First failure - 20 min backoff
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(agentCommand).toHaveBeenCalled();
      vi.mocked(agentCommand).mockClear();

      // Wait 20 min, second failure - 40 min backoff (20 * 2)
      await vi.advanceTimersByTimeAsync(1 * 60_000);
      expect(agentCommand).toHaveBeenCalled();
      vi.mocked(agentCommand).mockClear();

      // After 20 min - still in backoff (40 min required)
      await vi.advanceTimersByTimeAsync(1 * 60_000);
      expect(agentCommand).not.toHaveBeenCalled();

      // After 40 min total - backoff expired
      await vi.advanceTimersByTimeAsync(1 * 60_000);
      expect(agentCommand).toHaveBeenCalled();

      runner.stop();
    });

    it("resets failure state on successful continuation", async () => {
      vi.mocked(findActiveTask).mockResolvedValue(idleTask);

      // First call fails
      vi.mocked(agentCommand).mockRejectedValueOnce(new Error("rate_limit"));

      const runner = startTaskContinuationRunner({
        cfg: { agents: { defaults: {} } } as OpenClawConfig,
      });

      // First attempt - fails
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(agentCommand).toHaveBeenCalled();

      // Now make it succeed
      vi.mocked(agentCommand).mockResolvedValue({
        text: "ok",
        sessionId: "test",
        usage: { inputTokens: 0, outputTokens: 0 },
      });

      // Wait for backoff to expire (20 min)
      await vi.advanceTimersByTimeAsync(1 * 60_000);
      expect(agentCommand).toHaveBeenCalledTimes(2);

      // Third attempt after normal cooldown (5 min) - should work (not 40 min exponential)
      // Check interval is 2 min, so next check after cooldown expires is at +6 min
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(agentCommand).toHaveBeenCalledTimes(3);

      runner.stop();
    });

    it("caps backoff at 2 hours maximum", async () => {
      vi.mocked(findActiveTask).mockResolvedValue(idleTask);
      vi.mocked(agentCommand).mockRejectedValue(new Error("billing error"));

      const runner = startTaskContinuationRunner({
        cfg: { agents: { defaults: {} } } as OpenClawConfig,
      });

      // Simulate multiple failures to trigger exponential backoff
      // billing = 1hr base, after 3 failures would be 4hr, but capped at 2hr
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(2 * 60 * 60_000 + 3 * 60_000); // 2hr + 3min
      }

      vi.mocked(agentCommand).mockClear();

      // After 2 hours (max cap) - should retry
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(agentCommand).toHaveBeenCalled();

      runner.stop();
    });

    it("detects rate_limit from 429 status code message", async () => {
      vi.mocked(findActiveTask).mockResolvedValue(idleTask);
      vi.mocked(agentCommand).mockRejectedValue(new Error("HTTP 429 Too Many Requests"));

      const runner = startTaskContinuationRunner({
        cfg: { agents: { defaults: {} } } as OpenClawConfig,
      });

      // First attempt fails with 429 -> detected as rate_limit -> 1 min backoff
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(agentCommand).toHaveBeenCalled();

      vi.mocked(agentCommand).mockClear();

      // Next check at T+4 - backoff expired, retry (fails again -> 2 min backoff)
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(agentCommand).toHaveBeenCalled();

      runner.stop();
    });

    it("detects context_overflow from error message", async () => {
      vi.mocked(findActiveTask).mockResolvedValue(idleTask);
      vi.mocked(agentCommand).mockRejectedValue(
        new Error("context overflow: token limit exceeded"),
      );

      const runner = startTaskContinuationRunner({
        cfg: { agents: { defaults: {} } } as OpenClawConfig,
      });

      // First attempt fails with context_overflow -> 30 min backoff
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(agentCommand).toHaveBeenCalled();

      vi.mocked(agentCommand).mockClear();

      // After 15 minutes - still in backoff (30 min required)
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(agentCommand).not.toHaveBeenCalled();

      // After 30 minutes total from fail - backoff expired, should retry
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(agentCommand).toHaveBeenCalled();

      runner.stop();
    });
  });

  describe("agent-specific queue check", () => {
    const idleTask = {
      id: "task_abc123",
      status: "in_progress" as const,
      priority: "high" as const,
      description: "Fix the bug",
      created: "2026-02-05T09:50:00Z",
      lastActivity: "2026-02-05T09:50:00Z",
      progress: ["Started"],
    };

    it("checks agent-specific lane, not global main queue", async () => {
      vi.mocked(findActiveTask).mockResolvedValue(idleTask);

      // Mock getQueueSize to return different values based on lane
      vi.mocked(getQueueSize).mockImplementation((lane: string) => {
        if (lane === "main") {
          return 5; // Global main queue has items
        }
        if (lane === "session:agent:main:main") {
          return 0; // Agent-specific queue is empty
        }
        return 0;
      });

      const runner = startTaskContinuationRunner({
        cfg: { agents: { defaults: {} } } as OpenClawConfig,
      });

      await vi.advanceTimersByTimeAsync(3 * 60_000);

      // Should send prompt because agent-specific queue is empty
      // (even though global main queue has items)
      expect(agentCommand).toHaveBeenCalled();
      runner.stop();
    });

    it("skips when agent-specific queue has items", async () => {
      vi.mocked(findActiveTask).mockResolvedValue(idleTask);

      // Mock getQueueSize: agent-specific queue has items
      vi.mocked(getQueueSize).mockImplementation((lane: string) => {
        if (lane === "session:agent:main:main") {
          return 2; // Agent-specific queue has items
        }
        return 0;
      });

      const runner = startTaskContinuationRunner({
        cfg: { agents: { defaults: {} } } as OpenClawConfig,
      });

      await vi.advanceTimersByTimeAsync(3 * 60_000);

      // Should NOT send prompt because agent is busy
      expect(agentCommand).not.toHaveBeenCalled();
      runner.stop();
    });

    it("uses correct lane format for each agent", async () => {
      vi.mocked(findActiveTask).mockResolvedValue(idleTask);

      const checkedLanes: string[] = [];
      vi.mocked(getQueueSize).mockImplementation((lane: string) => {
        checkedLanes.push(lane);
        return 0;
      });

      const runner = startTaskContinuationRunner({
        cfg: {
          agents: {
            defaults: {},
            list: [{ id: "dajim" }, { id: "eden" }],
          },
        } as OpenClawConfig,
      });

      await vi.advanceTimersByTimeAsync(3 * 60_000);

      // Should check agent-specific lanes for each agent
      // When agents.list is provided, first agent becomes default (not "main")
      expect(checkedLanes).toContain("session:agent:dajim:main");
      expect(checkedLanes).toContain("session:agent:eden:main");

      // Should NOT check global main queue
      expect(checkedLanes).not.toContain("main");

      runner.stop();
    });
  });
});
