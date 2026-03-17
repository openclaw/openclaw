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
  resolveOagEvolutionCooldownMs: () => 4 * 60 * 60_000,
  resolveOagEvolutionObservationWindowMs: () => 60 * 60_000,
  resolveOagEvolutionRestartRegressionThreshold: () => 5,
  resolveOagEvolutionFailureRegressionThreshold: () => 3,
  resolveOagEvolutionPeriodicAnalysisIntervalMs: () => 6 * 60 * 60_000,
}));

vi.mock("./oag-metrics.js", () => ({
  getOagMetrics: () => ({}),
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

const { runPostRecoveryAnalysis, schedulePeriodicAnalysis, analyzeMetricTrends } =
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
    const budgetRec = result.recommendations.find(
      (r) => r.configPath === "gateway.oag.delivery.recoveryBudgetMs",
    );
    expect(budgetRec).toBeDefined();
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
    const budgetRec = result.recommendations.find(
      (r) => r.configPath === "gateway.oag.delivery.recoveryBudgetMs",
    );
    expect(budgetRec).toBeDefined();
    // Incident has "telegram" — that should take precedence over sentinel "slack"
    expect(budgetRec!.reason).toContain("telegram");
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
