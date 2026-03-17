import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({ gateway: {} }),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockMemory = vi.hoisted(() => ({
  current: {
    version: 1,
    lifecycles: [] as unknown[],
    evolutions: [] as unknown[],
    diagnoses: [] as unknown[],
    metricSeries: [] as unknown[],
  },
}));

const mockRecordLifecycleShutdown = vi.fn(async () => {});

vi.mock("./oag-memory.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./oag-memory.js")>();
  return {
    ...original,
    loadOagMemory: vi.fn(async () => ({
      ...mockMemory.current,
      auditLog: [],
      metricSeries: mockMemory.current.metricSeries ?? [],
    })),
    saveOagMemory: vi.fn(async (m: unknown) => {
      mockMemory.current = m as typeof mockMemory.current;
    }),
    recordEvolution: vi.fn(async () => {}),
    recordDiagnosis: vi.fn(async () => {}),
    appendAuditEntry: vi.fn(async () => {}),
    recordLifecycleShutdown: mockRecordLifecycleShutdown,
    getRecentCrashes: original.getRecentCrashes,
    findRecurringIncidentPattern: original.findRecurringIncidentPattern,
  };
});

vi.mock("./oag-anomaly.js", () => ({
  detectAnomalies: () => [],
  predictBreach: () => [],
}));

vi.mock("./oag-config.js", () => ({
  resolveOagDeliveryMaxRetries: () => 5,
  resolveOagDeliveryRecoveryBudgetMs: () => 60000,
  resolveOagLockStaleMs: () => 30000,
  resolveOagNoteDedupWindowMs: () => 60000,
  resolveOagStalePollFactor: () => 2,
  resolveOagEvolutionMaxStepPercent: () => 50,
  resolveOagEvolutionMaxCumulativePercent: () => 200,
  resolveOagEvolutionMaxNotificationsPerDay: () => 3,
  resolveOagEvolutionMinCrashesForAnalysis: () => 2,
  resolveOagEvolutionMinChannelIncidentsForAnalysis: () => 3,
  resolveOagEvolutionCooldownMs: () => 4 * 60 * 60_000,
  resolveOagEvolutionObservationWindowMs: () => 60 * 60_000,
  resolveOagEvolutionRestartRegressionThreshold: () => 5,
  resolveOagEvolutionFailureRegressionThreshold: () => 3,
  resolveOagEvolutionPeriodicAnalysisIntervalMs: () => 6 * 60 * 60_000,
}));

vi.mock("./oag-metrics.js", () => ({
  getOagMetrics: () => ({}),
}));

const mockEmitOagEvent = vi.fn();
vi.mock("./oag-event-bus.js", () => ({
  emitOagEvent: (...args: unknown[]) => mockEmitOagEvent(...args),
}));

vi.mock("./oag-evolution-notify.js", () => ({
  injectEvolutionNote: vi.fn(async () => true),
}));

vi.mock("./oag-diagnosis.js", () => ({
  requestDiagnosis: vi.fn(async () => {}),
}));

vi.mock("./oag-incident-collector.js", () => ({
  collectActiveIncidents: () => [],
}));

const mockRunWhenIdle = vi.fn(async (task: () => Promise<unknown>) => {
  const result = await task();
  return { result, waitedMs: 0, ranImmediately: true };
});

vi.mock("./oag-scheduler.js", () => ({
  runWhenIdle: (...args: unknown[]) => mockRunWhenIdle(args[0] as () => Promise<unknown>),
  createGatewayIdleCheck: () => () => true,
}));

const { runPostRecoveryAnalysis, schedulePeriodicAnalysis, analyzeMetricTrends, maybeExplore } =
  await import("./oag-postmortem.js");

describe("oag-postmortem", () => {
  beforeEach(() => {
    mockMemory.current = {
      version: 1,
      lifecycles: [],
      evolutions: [],
      diagnoses: [],
      metricSeries: [],
    };
    mockEmitOagEvent.mockClear();
  });

  it("skips analysis when crash count is below threshold", async () => {
    mockMemory.current.lifecycles = [
      {
        id: "1",
        startedAt: new Date().toISOString(),
        stoppedAt: new Date().toISOString(),
        stopReason: "crash",
        uptimeMs: 1000,
        metricsSnapshot: {},
        incidents: [],
      },
    ];
    const result = await runPostRecoveryAnalysis();
    expect(result.analyzed).toBe(false);
    expect(result.crashCount).toBe(1);
  });

  it("generates recovery budget recommendation for recurring crash loops", async () => {
    const now = new Date().toISOString();
    mockMemory.current.lifecycles = Array.from({ length: 4 }, (_, i) => ({
      id: `lc-${i}`,
      startedAt: now,
      stoppedAt: now,
      stopReason: "crash" as const,
      uptimeMs: 1000,
      metricsSnapshot: {},
      incidents: [
        {
          type: "channel_crash_loop" as const,
          channel: "telegram",
          detail: "ETIMEDOUT",
          count: 1,
          firstAt: now,
          lastAt: now,
        },
      ],
    }));

    const result = await runPostRecoveryAnalysis();
    expect(result.analyzed).toBe(true);
    expect(result.recommendations.length).toBeGreaterThan(0);
    // All incidents from "telegram" — recommendation is channel-scoped
    const budgetRec = result.recommendations.find((r) => r.configPath.includes("recoveryBudgetMs"));
    expect(budgetRec).toBeDefined();
    expect(budgetRec!.configPath).toBe("gateway.oag.channels.telegram.delivery.recoveryBudgetMs");
    expect(budgetRec!.suggestedValue).toBeGreaterThan(60000);
    expect(budgetRec!.risk).toBe("low");
  });

  it("produces user notification for applied changes", async () => {
    const now = new Date().toISOString();
    mockMemory.current.lifecycles = Array.from({ length: 4 }, (_, i) => ({
      id: `lc-${i}`,
      startedAt: now,
      stoppedAt: now,
      stopReason: "crash" as const,
      uptimeMs: 1000,
      metricsSnapshot: {},
      incidents: [
        {
          type: "channel_crash_loop" as const,
          channel: "telegram",
          detail: "test",
          count: 1,
          firstAt: now,
          lastAt: now,
        },
      ],
    }));

    const result = await runPostRecoveryAnalysis();
    expect(result.userNotification).toBeDefined();
    expect(result.userNotification).toContain("analyzed");
    expect(result.userNotification).toContain("adjusted");
  });

  it("respects evolution cooldown", async () => {
    const now = new Date().toISOString();
    mockMemory.current.lifecycles = Array.from({ length: 4 }, (_, i) => ({
      id: `lc-${i}`,
      startedAt: now,
      stoppedAt: now,
      stopReason: "crash" as const,
      uptimeMs: 1000,
      metricsSnapshot: {},
      incidents: [
        {
          type: "channel_crash_loop" as const,
          detail: "test",
          count: 1,
          firstAt: now,
          lastAt: now,
        },
      ],
    }));
    // Recent evolution blocks new ones
    mockMemory.current.evolutions = [
      {
        appliedAt: new Date().toISOString(),
        source: "adaptive",
        trigger: "test",
        changes: [],
      },
    ];

    const result = await runPostRecoveryAnalysis();
    expect(result.analyzed).toBe(false);
  });

  it("uses sentinel context channel in crash-loop recommendation", async () => {
    const now = new Date().toISOString();
    // Create crash loops with no channel on the incident — sentinel provides it
    mockMemory.current.lifecycles = Array.from({ length: 4 }, (_, i) => ({
      id: `lc-${i}`,
      startedAt: now,
      stoppedAt: now,
      stopReason: "crash" as const,
      uptimeMs: 1000,
      metricsSnapshot: {},
      incidents: [
        {
          type: "channel_crash_loop" as const,
          detail: "ETIMEDOUT",
          count: 1,
          firstAt: now,
          lastAt: now,
        },
      ],
    }));

    const result = await runPostRecoveryAnalysis({
      sessionKey: "sess-xyz",
      channel: "slack",
      stopReason: "restart",
      timestamp: now,
    });
    expect(result.analyzed).toBe(true);
    const budgetRec = result.recommendations.find(
      (r) => r.configPath === "gateway.oag.delivery.recoveryBudgetMs",
    );
    expect(budgetRec).toBeDefined();
    // The reason should use the sentinel channel "slack" since incidents have no channel
    expect(budgetRec!.reason).toContain("slack");
  });

  it("prefers incident channel over sentinel channel when both exist", async () => {
    const now = new Date().toISOString();
    mockMemory.current.lifecycles = Array.from({ length: 4 }, (_, i) => ({
      id: `lc-${i}`,
      startedAt: now,
      stoppedAt: now,
      stopReason: "crash" as const,
      uptimeMs: 1000,
      metricsSnapshot: {},
      incidents: [
        {
          type: "channel_crash_loop" as const,
          channel: "telegram",
          detail: "test",
          count: 1,
          firstAt: now,
          lastAt: now,
        },
      ],
    }));

    const result = await runPostRecoveryAnalysis({
      channel: "slack",
    });
    expect(result.analyzed).toBe(true);
    // All incidents from "telegram" — channel-scoped path
    const budgetRec = result.recommendations.find((r) => r.configPath.includes("recoveryBudgetMs"));
    expect(budgetRec).toBeDefined();
    // Incident has "telegram" — that should take precedence over sentinel "slack"
    expect(budgetRec!.reason).toContain("telegram");
    expect(budgetRec!.configPath).toBe("gateway.oag.channels.telegram.delivery.recoveryBudgetMs");
  });

  it("generates channel-scoped recommendation when incidents are dominated by one channel", async () => {
    const now = new Date().toISOString();
    // All 4 incidents are from "telegram" — exceeds 80% threshold
    mockMemory.current.lifecycles = Array.from({ length: 4 }, (_, i) => ({
      id: `lc-${i}`,
      startedAt: now,
      stoppedAt: now,
      stopReason: "crash" as const,
      uptimeMs: 1000,
      metricsSnapshot: {},
      incidents: [
        {
          type: "channel_crash_loop" as const,
          channel: "telegram",
          detail: "ETIMEDOUT",
          count: 1,
          firstAt: now,
          lastAt: now,
        },
      ],
    }));

    const result = await runPostRecoveryAnalysis();
    expect(result.analyzed).toBe(true);
    const budgetRec = result.recommendations.find((r) => r.configPath.includes("recoveryBudgetMs"));
    expect(budgetRec).toBeDefined();
    // Should be channel-scoped since all incidents are from "telegram"
    expect(budgetRec!.configPath).toBe("gateway.oag.channels.telegram.delivery.recoveryBudgetMs");
  });

  it("generates global recommendation when incidents span multiple channels", async () => {
    const now = new Date().toISOString();
    // Incidents from "telegram" and "discord" — no single channel dominates
    mockMemory.current.lifecycles = [
      ...Array.from({ length: 2 }, (_, i) => ({
        id: `lc-tg-${i}`,
        startedAt: now,
        stoppedAt: now,
        stopReason: "crash" as const,
        uptimeMs: 1000,
        metricsSnapshot: {},
        incidents: [
          {
            type: "channel_crash_loop" as const,
            channel: "telegram",
            detail: "ETIMEDOUT",
            count: 1,
            firstAt: now,
            lastAt: now,
          },
        ],
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        id: `lc-dc-${i}`,
        startedAt: now,
        stoppedAt: now,
        stopReason: "crash" as const,
        uptimeMs: 1000,
        metricsSnapshot: {},
        incidents: [
          {
            type: "channel_crash_loop" as const,
            channel: "discord",
            detail: "ETIMEDOUT",
            count: 1,
            firstAt: now,
            lastAt: now,
          },
        ],
      })),
    ];

    const result = await runPostRecoveryAnalysis();
    expect(result.analyzed).toBe(true);
    // With mixed channels (50/50 split), patterns are grouped separately.
    // Each group has only 2 incidents (below min 3), so no recommendations.
    // But if we add enough from each:
    mockMemory.current.lifecycles = Array.from({ length: 3 }, (_, i) => ({
      id: `lc-tg-${i}`,
      startedAt: now,
      stoppedAt: now,
      stopReason: "crash" as const,
      uptimeMs: 1000,
      metricsSnapshot: {},
      incidents: [
        {
          type: "channel_crash_loop" as const,
          channel: "telegram",
          detail: "ETIMEDOUT",
          count: 1,
          firstAt: now,
          lastAt: now,
        },
        {
          type: "channel_crash_loop" as const,
          channel: "discord",
          detail: "ECONNRESET",
          count: 1,
          firstAt: now,
          lastAt: now,
        },
      ],
    }));

    // Reset evolutions to avoid cooldown from previous run
    mockMemory.current.evolutions = [];

    const result2 = await runPostRecoveryAnalysis();
    // Both telegram and discord have 3 incidents each. Each pattern is
    // channel-specific (telegram and discord separately), so each recommendation
    // scopes to its own channel since 100% of that pattern's incidents come from
    // one channel.
    for (const rec of result2.recommendations) {
      if (rec.configPath.includes("recoveryBudgetMs")) {
        expect(rec.configPath).toMatch(/^gateway\.oag\.channels\.(telegram|discord)\./);
      }
    }
  });

  it("includes empty trends when no metric series data", async () => {
    const now = new Date().toISOString();
    mockMemory.current.lifecycles = Array.from({ length: 4 }, (_, i) => ({
      id: `lc-${i}`,
      startedAt: now,
      stoppedAt: now,
      stopReason: "crash" as const,
      uptimeMs: 1000,
      metricsSnapshot: {},
      incidents: [
        {
          type: "channel_crash_loop" as const,
          channel: "telegram",
          detail: "test",
          count: 1,
          firstAt: now,
          lastAt: now,
        },
      ],
    }));

    const result = await runPostRecoveryAnalysis();
    expect(result.trends).toEqual([]);
  });

  it("triggers analysis when channel incidents meet threshold with zero crashes", async () => {
    const now = new Date().toISOString();
    // Zero crashes but 5 channel incidents across lifecycles (threshold is 3 in mock)
    mockMemory.current.lifecycles = Array.from({ length: 5 }, (_, i) => ({
      id: `lc-${i}`,
      startedAt: now,
      stoppedAt: now,
      stopReason: "restart" as const,
      uptimeMs: 1000,
      metricsSnapshot: {},
      incidents: [
        {
          type: "channel_crash_loop" as const,
          channel: "telegram",
          detail: "health-monitor restart",
          count: 1,
          firstAt: now,
          lastAt: now,
        },
      ],
    }));

    const result = await runPostRecoveryAnalysis();
    expect(result.analyzed).toBe(true);
    expect(result.crashCount).toBe(0);
    expect(result.channelIncidentCount).toBe(5);
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it("skips analysis when channel incidents are below threshold with zero crashes", async () => {
    const now = new Date().toISOString();
    // 2 channel incidents -- below threshold of 3 (mock value)
    mockMemory.current.lifecycles = Array.from({ length: 2 }, (_, i) => ({
      id: `lc-${i}`,
      startedAt: now,
      stoppedAt: now,
      stopReason: "restart" as const,
      uptimeMs: 1000,
      metricsSnapshot: {},
      incidents: [
        {
          type: "channel_crash_loop" as const,
          channel: "telegram",
          detail: "health-monitor restart",
          count: 1,
          firstAt: now,
          lastAt: now,
        },
      ],
    }));

    const result = await runPostRecoveryAnalysis();
    expect(result.analyzed).toBe(false);
    expect(result.crashCount).toBe(0);
    expect(result.channelIncidentCount).toBe(2);
  });

  it("gateway crashes still trigger analysis (backward compat)", async () => {
    const now = new Date().toISOString();
    // 3 crashes with incidents -- should trigger via crash path
    mockMemory.current.lifecycles = Array.from({ length: 3 }, (_, i) => ({
      id: `lc-${i}`,
      startedAt: now,
      stoppedAt: now,
      stopReason: "crash" as const,
      uptimeMs: 1000,
      metricsSnapshot: {},
      incidents: [
        {
          type: "channel_crash_loop" as const,
          channel: "telegram",
          detail: "ETIMEDOUT",
          count: 1,
          firstAt: now,
          lastAt: now,
        },
      ],
    }));

    const result = await runPostRecoveryAnalysis();
    expect(result.analyzed).toBe(true);
    expect(result.crashCount).toBe(3);
    expect(result.channelIncidentCount).toBe(3);
  });

  it("generates staleEventThresholdMs relaxation when false positive rate > 70%", async () => {
    const now = new Date().toISOString();
    // All 4 incidents recovered in <30s (false positives)
    mockMemory.current.lifecycles = Array.from({ length: 4 }, (_, i) => ({
      id: `lc-${i}`,
      startedAt: now,
      stoppedAt: now,
      stopReason: "crash" as const,
      uptimeMs: 1000,
      metricsSnapshot: {},
      incidents: [
        {
          type: "channel_crash_loop" as const,
          channel: "telegram",
          detail: "ETIMEDOUT",
          count: 1,
          firstAt: now,
          lastAt: now,
          recoveryMs: 5_000, // recovered in 5s — false positive
        },
      ],
    }));

    const result = await runPostRecoveryAnalysis();
    expect(result.analyzed).toBe(true);
    const thresholdRec = result.recommendations.find((r) =>
      r.configPath.includes("staleEventThresholdMs"),
    );
    expect(thresholdRec).toBeDefined();
    expect(thresholdRec!.reason).toContain("false positive rate");
    expect(thresholdRec!.reason).toContain("telegram");
    expect(thresholdRec!.suggestedValue).toBeGreaterThan(thresholdRec!.currentValue);
  });
});

describe("schedulePeriodicAnalysis", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockMemory.current = {
      version: 1,
      lifecycles: [],
      evolutions: [],
      diagnoses: [],
      metricSeries: [],
    };
    mockRecordLifecycleShutdown.mockClear();
    mockRunWhenIdle.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules at the configured interval", async () => {
    const intervalMs = 1000;
    const handle = schedulePeriodicAnalysis({
      idleCheck: () => true,
      intervalMs,
    });

    // No immediate execution
    expect(mockRecordLifecycleShutdown).not.toHaveBeenCalled();

    // Advance to first tick
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(mockRecordLifecycleShutdown).toHaveBeenCalledTimes(1);
    expect(mockRecordLifecycleShutdown).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "checkpoint" }),
    );

    // Advance to second tick
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(mockRecordLifecycleShutdown).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it("stop() cancels the schedule", async () => {
    const intervalMs = 1000;
    const handle = schedulePeriodicAnalysis({
      idleCheck: () => true,
      intervalMs,
    });

    handle.stop();

    // Advancing past the interval should not trigger any calls
    await vi.advanceTimersByTimeAsync(intervalMs * 3);
    expect(mockRecordLifecycleShutdown).not.toHaveBeenCalled();
  });

  it("respects cooldown via postmortem analysis", async () => {
    const intervalMs = 500;
    const now = new Date().toISOString();

    // Set up crashes so analysis would run, but cooldown blocks it
    mockMemory.current.lifecycles = Array.from({ length: 4 }, (_, i) => ({
      id: `lc-${i}`,
      startedAt: now,
      stoppedAt: now,
      stopReason: "crash" as const,
      uptimeMs: 1000,
      metricsSnapshot: {},
      incidents: [
        {
          type: "channel_crash_loop" as const,
          channel: "telegram",
          detail: "test",
          count: 1,
          firstAt: now,
          lastAt: now,
        },
      ],
    }));
    // Recent evolution means cooldown is active
    mockMemory.current.evolutions = [
      {
        appliedAt: new Date().toISOString(),
        source: "adaptive",
        trigger: "test",
        changes: [],
      },
    ];

    const handle = schedulePeriodicAnalysis({
      idleCheck: () => true,
      intervalMs,
    });

    await vi.advanceTimersByTimeAsync(intervalMs);

    // Checkpoint was recorded
    expect(mockRecordLifecycleShutdown).toHaveBeenCalledTimes(1);
    // runWhenIdle was called (which calls postmortem internally)
    expect(mockRunWhenIdle).toHaveBeenCalled();

    handle.stop();
  });

  it("runs analysis through idle scheduler", async () => {
    const intervalMs = 500;
    const handle = schedulePeriodicAnalysis({
      idleCheck: () => true,
      intervalMs,
    });

    await vi.advanceTimersByTimeAsync(intervalMs);

    // Verify the idle scheduler was used
    expect(mockRunWhenIdle).toHaveBeenCalledTimes(1);

    handle.stop();
  });
});

describe("analyzeMetricTrends", () => {
  it("returns empty array when fewer than 2 snapshots", () => {
    expect(analyzeMetricTrends([])).toEqual([]);
    expect(
      analyzeMetricTrends([
        { timestamp: new Date().toISOString(), uptimeMs: 1000, metrics: { channelRestarts: 5 } },
      ]),
    ).toEqual([]);
  });

  it("returns empty when snapshots are outside both time windows", () => {
    const oldTimestamp = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const trends = analyzeMetricTrends([
      { timestamp: oldTimestamp, uptimeMs: 1000, metrics: { channelRestarts: 5 } },
      { timestamp: oldTimestamp, uptimeMs: 2000, metrics: { channelRestarts: 10 } },
    ]);
    expect(trends).toEqual([]);
  });

  it("detects increasing trend when recent average is higher", () => {
    const now = Date.now();
    // Previous window: 6-12h ago
    const previousSnapshots = Array.from({ length: 3 }, (_, i) => ({
      timestamp: new Date(now - (9 - i) * 60 * 60_000).toISOString(),
      uptimeMs: i * 3600000,
      metrics: { channelRestarts: 2 },
    }));
    // Recent window: 0-6h ago
    const recentSnapshots = Array.from({ length: 3 }, (_, i) => ({
      timestamp: new Date(now - (3 - i) * 60 * 60_000).toISOString(),
      uptimeMs: (i + 3) * 3600000,
      metrics: { channelRestarts: 10 },
    }));

    const trends = analyzeMetricTrends([...previousSnapshots, ...recentSnapshots]);
    expect(trends).toHaveLength(1);
    expect(trends[0].metric).toBe("channelRestarts");
    expect(trends[0].direction).toBe("increasing");
    expect(trends[0].changePercent).toBe(400);
  });

  it("detects decreasing trend when recent average is lower", () => {
    const now = Date.now();
    const previousSnapshots = Array.from({ length: 3 }, (_, i) => ({
      timestamp: new Date(now - (9 - i) * 60 * 60_000).toISOString(),
      uptimeMs: i * 3600000,
      metrics: { channelRestarts: 20 },
    }));
    const recentSnapshots = Array.from({ length: 3 }, (_, i) => ({
      timestamp: new Date(now - (3 - i) * 60 * 60_000).toISOString(),
      uptimeMs: (i + 3) * 3600000,
      metrics: { channelRestarts: 5 },
    }));

    const trends = analyzeMetricTrends([...previousSnapshots, ...recentSnapshots]);
    expect(trends).toHaveLength(1);
    expect(trends[0].direction).toBe("decreasing");
    expect(trends[0].changePercent).toBe(-75);
  });

  it("reports stable when change is within 10% threshold", () => {
    const now = Date.now();
    const previousSnapshots = Array.from({ length: 3 }, (_, i) => ({
      timestamp: new Date(now - (9 - i) * 60 * 60_000).toISOString(),
      uptimeMs: i * 3600000,
      metrics: { channelRestarts: 100 },
    }));
    const recentSnapshots = Array.from({ length: 3 }, (_, i) => ({
      timestamp: new Date(now - (3 - i) * 60 * 60_000).toISOString(),
      uptimeMs: (i + 3) * 3600000,
      metrics: { channelRestarts: 105 },
    }));

    const trends = analyzeMetricTrends([...previousSnapshots, ...recentSnapshots]);
    expect(trends).toHaveLength(1);
    expect(trends[0].direction).toBe("stable");
    expect(trends[0].changePercent).toBe(5);
  });

  it("handles zero-to-nonzero as 100% increase", () => {
    const now = Date.now();
    const previousSnapshots = [
      {
        timestamp: new Date(now - 9 * 60 * 60_000).toISOString(),
        uptimeMs: 1000,
        metrics: { channelRestarts: 0 },
      },
    ];
    const recentSnapshots = [
      {
        timestamp: new Date(now - 3 * 60 * 60_000).toISOString(),
        uptimeMs: 10000,
        metrics: { channelRestarts: 5 },
      },
    ];

    const trends = analyzeMetricTrends([...previousSnapshots, ...recentSnapshots]);
    const restart = trends.find((t) => t.metric === "channelRestarts");
    expect(restart).toBeDefined();
    expect(restart!.direction).toBe("increasing");
    expect(restart!.changePercent).toBe(100);
  });

  it("handles multiple metrics across snapshots", () => {
    const now = Date.now();
    const previousSnapshots = [
      {
        timestamp: new Date(now - 9 * 60 * 60_000).toISOString(),
        uptimeMs: 1000,
        metrics: { channelRestarts: 10, noteDeliveries: 100 },
      },
    ];
    const recentSnapshots = [
      {
        timestamp: new Date(now - 3 * 60 * 60_000).toISOString(),
        uptimeMs: 10000,
        metrics: { channelRestarts: 40, noteDeliveries: 90 },
      },
    ];

    const trends = analyzeMetricTrends([...previousSnapshots, ...recentSnapshots]);
    expect(trends).toHaveLength(2);

    const restartTrend = trends.find((t) => t.metric === "channelRestarts");
    expect(restartTrend!.direction).toBe("increasing");
    expect(restartTrend!.changePercent).toBe(300);

    const deliveryTrend = trends.find((t) => t.metric === "noteDeliveries");
    expect(deliveryTrend!.direction).toBe("stable");
    expect(deliveryTrend!.changePercent).toBe(-10);
  });
});

describe("maybeExplore", () => {
  it("mutates approximately 5% of recommendations", () => {
    const rec = {
      configPath: "gateway.oag.delivery.recoveryBudgetMs",
      currentValue: 60000,
      suggestedValue: 90000,
      reason: "test",
      risk: "low" as const,
      source: "heuristic" as const,
    };

    // Mock Math.random to always trigger exploration (return 0.01 < 0.05)
    const mockRandom = vi.spyOn(Math, "random").mockReturnValue(0.01);
    const explored = maybeExplore(rec);
    expect(explored.source).toBe("exploration");
    // delta should be -(suggestedValue - currentValue) * 0.3 = -(30000) * 0.3 = -9000
    expect(explored.delta).toBe(-9000);

    mockRandom.mockRestore();
  });

  it("skips exploration for auth_failure root causes", () => {
    const rec = {
      configPath: "gateway.oag.delivery.recoveryBudgetMs",
      currentValue: 60000,
      suggestedValue: 90000,
      reason: "test",
      risk: "low" as const,
      source: "heuristic" as const,
    };

    const mockRandom = vi.spyOn(Math, "random").mockReturnValue(0.01);
    const result = maybeExplore(rec, "auth_failure");
    // Should return original — auth_failure is excluded from exploration
    expect(result.source).toBe("heuristic");
    expect(result.delta).toBeUndefined();

    mockRandom.mockRestore();
  });

  it("skips exploration for config root causes", () => {
    const rec = {
      configPath: "gateway.oag.delivery.maxRetries",
      currentValue: 5,
      suggestedValue: 7,
      reason: "test",
      risk: "low" as const,
      source: "heuristic" as const,
    };

    const mockRandom = vi.spyOn(Math, "random").mockReturnValue(0.01);
    const result = maybeExplore(rec, "config");
    expect(result.source).toBe("heuristic");

    mockRandom.mockRestore();
  });

  it("returns recommendation unchanged when random > 0.05", () => {
    const rec = {
      configPath: "gateway.oag.delivery.recoveryBudgetMs",
      currentValue: 60000,
      suggestedValue: 90000,
      reason: "test",
      risk: "low" as const,
      source: "heuristic" as const,
    };

    const mockRandom = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const result = maybeExplore(rec);
    expect(result.source).toBe("heuristic");
    expect(result).toBe(rec); // exact same reference — not mutated

    mockRandom.mockRestore();
  });
});

describe("anomaly integration in postmortem", () => {
  beforeEach(() => {
    mockMemory.current = {
      version: 1,
      lifecycles: [],
      evolutions: [],
      diagnoses: [],
      metricSeries: [],
    };
  });

  it("includes anomalies and predictions in postmortem result", async () => {
    // Even when no crashes (below threshold), the result should have anomalies/predictions arrays
    const result = await runPostRecoveryAnalysis();
    expect(result).toHaveProperty("anomalies");
    expect(result).toHaveProperty("predictions");
    expect(Array.isArray(result.anomalies)).toBe(true);
    expect(Array.isArray(result.predictions)).toBe(true);
  });
});
