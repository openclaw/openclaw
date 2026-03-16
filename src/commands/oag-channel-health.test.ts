import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OagChannelHealthSummary } from "./oag-channel-health.js";
import {
  formatOagChannelHealthLine,
  formatOagSessionWatchLine,
  formatOagTaskWatchLine,
  readOagChannelHealthSummary,
} from "./oag-channel-health.js";

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
  },
}));

const readFileMock = vi.mocked(fs.readFile);
const previousHome = process.env.HOME;

function createSummary(overrides: Partial<OagChannelHealthSummary> = {}): OagChannelHealthSummary {
  return {
    congested: false,
    affectedChannels: [],
    affectedTargets: [],
    pendingDeliveries: 0,
    recentFailureCount: 0,
    ...overrides,
  };
}

describe("readOagChannelHealthSummary", () => {
  beforeEach(() => {
    process.env.HOME = "/tmp/test-home";
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("returns undefined when state file does not exist", async () => {
    readFileMock.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));

    await expect(readOagChannelHealthSummary()).resolves.toBeUndefined();
    expect(readFileMock).toHaveBeenCalledWith(
      "/tmp/test-home/.openclaw/sentinel/channel-health-state.json",
      "utf8",
    );
  });

  it("returns undefined when file contains invalid JSON", async () => {
    readFileMock.mockResolvedValueOnce("{invalid");

    await expect(readOagChannelHealthSummary()).resolves.toBeUndefined();
  });

  it("parses a valid minimal state", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        congested: false,
        pending_deliveries: 0,
        recent_failure_count: 0,
      }),
    );

    await expect(readOagChannelHealthSummary()).resolves.toEqual({
      schemaVersion: 1,
      congested: false,
      backloggedAfterRecovery: false,
      affectedChannels: [],
      affectedTargets: [],
      pendingDeliveries: 0,
      recentFailureCount: 0,
      backlogAgeMinutes: undefined,
      escalationRecommended: false,
      recommendedAction: undefined,
      verifyAttempts: undefined,
      lastAction: undefined,
      lastActionAt: undefined,
      lastActionDetail: undefined,
      lastVerifyAt: undefined,
      lastRestartAt: undefined,
      lastFailureAt: undefined,
      lastRecoveredAt: undefined,
      updatedAt: undefined,
      sessionWatch: undefined,
      taskWatch: undefined,
    });
  });

  it("parses affected_targets with snake_case fields", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        congested: true,
        pending_deliveries: 3,
        recent_failure_count: 2,
        affected_targets: [
          {
            channel: "telegram",
            account_id: "ops",
            session_keys: ["telegram:ops"],
            pending_deliveries: 3,
            recent_failures: 2,
          },
        ],
      }),
    );

    const summary = await readOagChannelHealthSummary();

    expect(summary?.affectedTargets).toEqual([
      {
        channel: "telegram",
        accountId: "ops",
        sessionKeys: ["telegram:ops"],
        pendingDeliveries: 3,
        recentFailures: 2,
      },
    ]);
  });

  it("parses affected_targets with camelCase fields", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        congested: true,
        pending_deliveries: 4,
        recent_failure_count: 1,
        affected_targets: [
          {
            channel: "signal",
            accountId: "primary",
            sessionKeys: ["signal:primary"],
            pendingDeliveries: 4,
            recentFailures: 1,
          },
        ],
      }),
    );

    const summary = await readOagChannelHealthSummary();

    expect(summary?.affectedTargets).toEqual([
      {
        channel: "signal",
        accountId: "primary",
        sessionKeys: ["signal:primary"],
        pendingDeliveries: 4,
        recentFailures: 1,
      },
    ]);
  });

  it("filters out non-string and empty session keys", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        congested: true,
        pending_deliveries: 1,
        recent_failure_count: 1,
        affected_targets: [
          {
            channel: "whatsapp",
            session_keys: ["good-key", "   ", 42, null, {}, " second-key "],
          },
        ],
      }),
    );

    const summary = await readOagChannelHealthSummary();

    expect(summary?.affectedTargets).toEqual([
      {
        channel: "whatsapp",
        accountId: undefined,
        sessionKeys: ["good-key", "second-key"],
        pendingDeliveries: undefined,
        recentFailures: undefined,
      },
    ]);
  });

  it("parses session_watch with affected_sessions", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        congested: false,
        pending_deliveries: 0,
        recent_failure_count: 0,
        session_watch: {
          active: true,
          affected_channels: ["telegram"],
          state_counts: { blocked: 2, stalled: "bad" },
          affected_sessions: [
            {
              agent_id: "agent-1",
              session_key: "telegram:ops",
              session_id: "session-1",
              channel: "telegram",
              account_id: "ops",
              state: "blocked",
              reason: "runtime error",
              silent_minutes: 18,
              blocked_retry_count: 3,
              escalation_recommended: true,
              recommended_action: "restart gateway",
            },
            {
              session_key: "   ",
            },
          ],
          last_action: "session_watchdog_cleared",
          last_action_detail: "recovered",
          updated_at: "2026-03-16T00:00:00Z",
        },
      }),
    );

    const summary = await readOagChannelHealthSummary();

    expect(summary?.sessionWatch).toEqual({
      active: true,
      affectedChannels: ["telegram"],
      stateCounts: { blocked: 2, stalled: 0 },
      affectedSessions: [
        {
          agentId: "agent-1",
          sessionKey: "telegram:ops",
          sessionId: "session-1",
          channel: "telegram",
          accountId: "ops",
          state: "blocked",
          reason: "runtime error",
          silentMinutes: 18,
          blockedRetryCount: 3,
          escalationRecommended: true,
          recommendedAction: "restart gateway",
        },
      ],
      escalationRecommended: false,
      recommendedAction: undefined,
      lastAction: "session_watchdog_cleared",
      lastActionAt: undefined,
      lastActionDetail: "recovered",
      lastNudgeAt: undefined,
      updatedAt: "2026-03-16T00:00:00Z",
    });
  });

  it("parses task_watch with affected_tasks", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        congested: false,
        pending_deliveries: 0,
        recent_failure_count: 0,
        task_watch: {
          active: true,
          counts: { running: 2, stuck: "bad" },
          escalation_recommended: true,
          recommended_action: "follow up now",
          affected_tasks: [
            {
              task_id: "task-1",
              followup_type: "normal follow-up",
              priority: "high",
              escalation_count: 2,
              current_step: 2,
              total_steps: 4,
              step_title: "Waiting",
              progress_age_seconds: 181,
              terminal_step_stuck: true,
              deferred_by: "queue",
              not_before: "2026-03-16T00:05:00Z",
              message: "stuck",
            },
            {
              task_id: "   ",
            },
          ],
          updated_at: "2026-03-16T00:10:00Z",
        },
      }),
    );

    const summary = await readOagChannelHealthSummary();

    expect(summary?.taskWatch).toEqual({
      active: true,
      counts: { running: 2, stuck: 0 },
      escalationRecommended: true,
      recommendedAction: "follow up now",
      affectedTasks: [
        {
          taskId: "task-1",
          followupType: "normal follow-up",
          priority: "high",
          escalationCount: 2,
          currentStep: 2,
          totalSteps: 4,
          stepTitle: "Waiting",
          progressAgeSeconds: 181,
          terminalStepStuck: true,
          deferredBy: "queue",
          notBefore: "2026-03-16T00:05:00Z",
          message: "stuck",
        },
      ],
      updatedAt: "2026-03-16T00:10:00Z",
    });
  });

  it("returns undefined when HOME env is not set", async () => {
    delete process.env.HOME;

    await expect(readOagChannelHealthSummary()).resolves.toBeUndefined();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  describe("schema versioning", () => {
    it("defaults to schema v1 when schema_version is absent", async () => {
      readFileMock.mockResolvedValueOnce(
        JSON.stringify({
          congested: false,
          pending_deliveries: 0,
          recent_failure_count: 0,
        }),
      );
      const summary = await readOagChannelHealthSummary();
      expect(summary?.schemaVersion).toBe(1);
    });

    it("detects schema v2 when schema_version is 2", async () => {
      readFileMock.mockResolvedValueOnce(
        JSON.stringify({
          schema_version: 2,
          congested: false,
          pending_deliveries: 0,
          recent_failure_count: 0,
          affected_targets: [
            {
              channel: "telegram",
              account_id: "default",
              session_keys: ["key1", "key2"],
              pending_deliveries: 3,
              recent_failures: 1,
            },
          ],
        }),
      );
      const summary = await readOagChannelHealthSummary();
      expect(summary?.schemaVersion).toBe(2);
      expect(summary?.affectedTargets).toEqual([
        {
          channel: "telegram",
          accountId: "default",
          sessionKeys: ["key1", "key2"],
          pendingDeliveries: 3,
          recentFailures: 1,
        },
      ]);
    });

    it("v2 rejects camelCase field names", async () => {
      readFileMock.mockResolvedValueOnce(
        JSON.stringify({
          schema_version: 2,
          congested: false,
          pending_deliveries: 0,
          recent_failure_count: 0,
          affected_targets: [
            {
              channel: "telegram",
              accountId: "default", // camelCase — v2 only reads snake_case
              sessionKeys: ["key1"], // camelCase — v2 only reads snake_case
            },
          ],
        }),
      );
      const summary = await readOagChannelHealthSummary();
      expect(summary?.affectedTargets?.[0]?.accountId).toBeUndefined();
      expect(summary?.affectedTargets?.[0]?.sessionKeys).toEqual([]);
    });
  });
});

describe("formatOagChannelHealthLine", () => {
  it("formats congested state with pending and failures", () => {
    expect(
      formatOagChannelHealthLine(
        createSummary({
          congested: true,
          affectedChannels: ["telegram", "signal"],
          pendingDeliveries: 7,
          recentFailureCount: 2,
          lastAction: "gateway_restart_triggered",
          lastActionDetail: "queued retries",
        }),
      ),
    ).toBe(
      "congested · 7 pending · 2 failures · OAG containing pressure on telegram, signal · OAG auto-restarted gateway · last=queued retries",
    );
  });

  it("formats escalationRecommended state with backlog age", () => {
    expect(
      formatOagChannelHealthLine(
        createSummary({
          pendingDeliveries: 5,
          backlogAgeMinutes: 42,
          escalationRecommended: true,
          lastAction: "recovery_verify",
          verifyAttempts: 3,
        }),
      ),
    ).toBe(
      "backlog prolonged · 5 pending · 42m · OAG recommends gateway restart · OAG verified x3",
    );
  });

  it("formats backloggedAfterRecovery state", () => {
    expect(
      formatOagChannelHealthLine(
        createSummary({
          backloggedAfterRecovery: true,
          affectedChannels: ["slack"],
          pendingDeliveries: 9,
          backlogAgeMinutes: 11,
          lastAction: "gateway_restart_deferred",
        }),
      ),
    ).toBe("recovering backlog · 9 pending · 11m · OAG verifying slack · OAG restart deferred");
  });

  it("formats clear state", () => {
    expect(
      formatOagChannelHealthLine(
        createSummary({
          pendingDeliveries: 0,
        }),
      ),
    ).toBe("clear · 0 pending");
  });

  it("returns unavailable when summary is undefined", () => {
    expect(formatOagChannelHealthLine(undefined)).toBe("unavailable");
  });
});

describe("formatOagSessionWatchLine", () => {
  it("formats escalation recommended", () => {
    expect(
      formatOagSessionWatchLine(
        createSummary({
          sessionWatch: {
            active: true,
            affectedChannels: ["telegram"],
            escalationRecommended: true,
            recommendedAction: "gateway restart",
            affectedSessions: [{ sessionKey: "telegram:ops" }],
            lastActionDetail: "runtime loop",
          },
        }),
      ),
    ).toBe(
      "blocked by model/runtime errors · watching 1 sessions · OAG recommends gateway restart · last=runtime loop",
    );
  });

  it("formats active watching", () => {
    expect(
      formatOagSessionWatchLine(
        createSummary({
          sessionWatch: {
            active: true,
            affectedChannels: ["signal"],
            stateCounts: { blocked: 2, waiting: 1 },
            affectedSessions: [{ sessionKey: "signal:1" }, { sessionKey: "signal:2" }],
          },
        }),
      ),
    ).toBe("watching 2 sessions · blocked:2, waiting:1 · signal");
  });

  it("formats cleared", () => {
    expect(
      formatOagSessionWatchLine(
        createSummary({
          sessionWatch: {
            active: false,
            affectedChannels: [],
            affectedSessions: [],
            lastAction: "session_watchdog_cleared",
            lastActionDetail: "nudged",
          },
        }),
      ),
    ).toBe("clear · recent recovery completed · last=nudged");
  });

  it("returns unavailable", () => {
    expect(formatOagSessionWatchLine(undefined)).toBe("unavailable");
  });
});

describe("formatOagTaskWatchLine", () => {
  it("formats terminal step stuck", () => {
    expect(
      formatOagTaskWatchLine(
        createSummary({
          taskWatch: {
            active: true,
            affectedTasks: [
              {
                taskId: "task-1",
                currentStep: 3,
                totalSteps: 5,
                progressAgeSeconds: 185,
                escalationCount: 2,
                terminalStepStuck: true,
              },
            ],
          },
        }),
      ),
    ).toBe("terminal step still running · step 3/5 · 3m · escalation x2");
  });

  it("formats normal follow-up with step progress", () => {
    expect(
      formatOagTaskWatchLine(
        createSummary({
          taskWatch: {
            active: true,
            affectedTasks: [
              {
                taskId: "task-2",
                followupType: "normal follow-up",
                currentStep: 1,
                totalSteps: 4,
                progressAgeSeconds: 121,
              },
            ],
          },
        }),
      ),
    ).toBe("normal follow-up · step 1/4 · 2m");
  });

  it("returns clear when no affected tasks", () => {
    expect(
      formatOagTaskWatchLine(
        createSummary({
          taskWatch: {
            active: true,
            affectedTasks: [],
          },
        }),
      ),
    ).toBe("clear");
  });

  it("returns unavailable", () => {
    expect(formatOagTaskWatchLine(undefined)).toBe("unavailable");
  });
});
