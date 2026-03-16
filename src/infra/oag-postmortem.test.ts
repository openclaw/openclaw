import { describe, expect, it, vi, beforeEach } from "vitest";

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
  },
}));

vi.mock("./oag-memory.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./oag-memory.js")>();
  return {
    ...original,
    loadOagMemory: vi.fn(async () => ({ ...mockMemory.current })),
    saveOagMemory: vi.fn(async (m: unknown) => {
      mockMemory.current = m as typeof mockMemory.current;
    }),
    recordEvolution: vi.fn(async () => {}),
    recordDiagnosis: vi.fn(async () => {}),
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
}));

vi.mock("./oag-metrics.js", () => ({
  getOagMetrics: () => ({}),
}));

const { runPostRecoveryAnalysis } = await import("./oag-postmortem.js");

describe("oag-postmortem", () => {
  beforeEach(() => {
    mockMemory.current = {
      version: 1,
      lifecycles: [],
      evolutions: [],
      diagnoses: [],
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
});
