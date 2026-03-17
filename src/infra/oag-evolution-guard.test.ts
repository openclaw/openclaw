import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mockMetrics = vi.hoisted(() => ({
  current: {
    channelRestarts: 0,
    deliveryRecoveryFailures: 0,
    deliveryRecoveries: 0,
    staleSocketDetections: 0,
    stalePollDetections: 0,
    noteDeliveries: 0,
    noteDeduplications: 0,
    lockAcquisitions: 0,
    lockStalRecoveries: 0,
  },
}));

vi.mock("./oag-metrics.js", () => ({
  getOagMetrics: () => ({ ...mockMetrics.current }),
}));

const appliedConfigs: unknown[][] = [];
vi.mock("./oag-config-writer.js", () => ({
  applyOagConfigChanges: vi.fn(async (changes: unknown[]) => {
    appliedConfigs.push(changes);
    return { applied: true };
  }),
}));

const mockMemory = vi.hoisted(() => ({
  current: { version: 1, lifecycles: [], evolutions: [] as unknown[], diagnoses: [] },
}));
vi.mock("./oag-config.js", () => ({
  resolveOagEvolutionObservationWindowMs: () => 60 * 60_000,
  resolveOagEvolutionRestartRegressionThreshold: () => 5,
  resolveOagEvolutionFailureRegressionThreshold: () => 3,
}));

const updateRecOutcomeCalls = vi.hoisted(
  () => [] as Array<{ diagnosisId: string; recommendationId: string; outcome: string }>,
);

vi.mock("./oag-memory.js", () => ({
  loadOagMemory: vi.fn(async () => ({
    ...mockMemory.current,
    evolutions: [...mockMemory.current.evolutions],
    auditLog: [],
  })),
  saveOagMemory: vi.fn(async (m: unknown) => {
    mockMemory.current = m as typeof mockMemory.current;
  }),
  appendAuditEntry: vi.fn(async () => {}),
  updateRecommendationOutcome: vi.fn(
    async (diagnosisId: string, recommendationId: string, outcome: string) => {
      updateRecOutcomeCalls.push({ diagnosisId, recommendationId, outcome });
      return true;
    },
  ),
}));

const {
  startEvolutionObservation,
  checkEvolutionHealth,
  clearObservation,
  restoreObservationFromMemory,
} = await import("./oag-evolution-guard.js");

describe("oag-evolution-guard", () => {
  beforeEach(async () => {
    await clearObservation();
    mockMetrics.current = {
      channelRestarts: 0,
      deliveryRecoveryFailures: 0,
      deliveryRecoveries: 0,
      staleSocketDetections: 0,
      stalePollDetections: 0,
      noteDeliveries: 0,
      noteDeduplications: 0,
      lockAcquisitions: 0,
      lockStalRecoveries: 0,
    };
    appliedConfigs.length = 0;
    updateRecOutcomeCalls.length = 0;
    mockMemory.current = { version: 1, lifecycles: [], evolutions: [], diagnoses: [] };
  });

  it("returns none when no observation active", async () => {
    const result = await checkEvolutionHealth();
    expect(result.action).toBe("none");
    expect(result.checked).toBe(false);
  });

  it("detects regression and rolls back config", async () => {
    mockMemory.current.evolutions = [
      {
        appliedAt: new Date().toISOString(),
        source: "adaptive",
        trigger: "test",
        changes: [],
        outcome: "pending",
      },
    ];
    await startEvolutionObservation({
      appliedAt: new Date().toISOString(),
      rollbackChanges: [
        { configPath: "gateway.oag.delivery.recoveryBudgetMs", previousValue: 60000 },
      ],
    });
    // Simulate regression
    mockMetrics.current.channelRestarts = 5;
    const result = await checkEvolutionHealth();
    expect(result.action).toBe("reverted");
    expect(result.reason).toContain("channel restarts spiked");
    expect(appliedConfigs).toHaveLength(1);
  });

  it("confirms evolution after observation window passes", async () => {
    mockMemory.current.evolutions = [
      {
        appliedAt: new Date().toISOString(),
        source: "adaptive",
        trigger: "test",
        changes: [],
        outcome: "pending",
      },
    ];
    await startEvolutionObservation({
      appliedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), // 2 hours ago
      rollbackChanges: [],
      windowMs: 60 * 60_000,
    });
    const result = await checkEvolutionHealth();
    expect(result.action).toBe("confirmed");
  });

  it("returns none during active observation with no regression", async () => {
    await startEvolutionObservation({
      appliedAt: new Date().toISOString(),
      rollbackChanges: [],
    });
    const result = await checkEvolutionHealth();
    expect(result.action).toBe("none");
    expect(result.checked).toBe(true);
  });

  it("persists observation to memory on start", async () => {
    const { saveOagMemory } = await import("./oag-memory.js");
    const saveSpy = vi.mocked(saveOagMemory);
    saveSpy.mockClear();

    await startEvolutionObservation({
      appliedAt: "2024-01-01T00:00:00.000Z",
      rollbackChanges: [
        { configPath: "gateway.oag.delivery.recoveryBudgetMs", previousValue: 60000 },
      ],
    });

    expect(saveSpy).toHaveBeenCalled();
    const savedMemory = saveSpy.mock.calls[saveSpy.mock.calls.length - 1][0] as {
      activeObservation: { evolutionAppliedAt: string; rollbackChanges: unknown[] };
    };
    expect(savedMemory.activeObservation).not.toBeNull();
    expect(savedMemory.activeObservation?.evolutionAppliedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(savedMemory.activeObservation?.rollbackChanges).toHaveLength(1);
  });

  it("restores observation from memory", async () => {
    mockMemory.current = {
      ...mockMemory.current,
      activeObservation: {
        evolutionAppliedAt: "2024-01-01T00:00:00.000Z",
        baselineMetrics: {
          channelRestarts: 0,
          deliveryRecoveryFailures: 0,
          stalePollDetections: 0,
        },
        rollbackChanges: [
          { configPath: "gateway.oag.delivery.recoveryBudgetMs", previousValue: 60000 },
        ],
        windowMs: 3600000,
      },
    } as typeof mockMemory.current;

    const restored = await restoreObservationFromMemory();
    expect(restored).toBe(true);

    // Observation should now be active
    const result = await checkEvolutionHealth();
    expect(result.checked).toBe(true);
  });

  describe("recommendation outcome linkage", () => {
    it("updates linked recommendations to 'reverted' on regression", async () => {
      mockMemory.current.evolutions = [
        {
          appliedAt: new Date().toISOString(),
          source: "agent-diagnosis",
          trigger: "diagnosis",
          changes: [],
          outcome: "pending",
        },
      ];
      await startEvolutionObservation({
        appliedAt: new Date().toISOString(),
        rollbackChanges: [
          { configPath: "gateway.oag.delivery.recoveryBudgetMs", previousValue: 60000 },
        ],
        diagnosisId: "diag-link-1",
        recommendationIds: ["diag-link-1-rec-0", "diag-link-1-rec-1"],
      });

      // Simulate regression
      mockMetrics.current.channelRestarts = 5;
      await checkEvolutionHealth();

      expect(updateRecOutcomeCalls).toHaveLength(2);
      expect(updateRecOutcomeCalls[0]).toEqual({
        diagnosisId: "diag-link-1",
        recommendationId: "diag-link-1-rec-0",
        outcome: "reverted",
      });
      expect(updateRecOutcomeCalls[1]).toEqual({
        diagnosisId: "diag-link-1",
        recommendationId: "diag-link-1-rec-1",
        outcome: "reverted",
      });
    });

    it("updates linked recommendations to 'effective' on confirmation", async () => {
      mockMemory.current.evolutions = [
        {
          appliedAt: new Date().toISOString(),
          source: "agent-diagnosis",
          trigger: "diagnosis",
          changes: [],
          outcome: "pending",
        },
      ];
      await startEvolutionObservation({
        appliedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
        rollbackChanges: [],
        windowMs: 60 * 60_000,
        diagnosisId: "diag-link-2",
        recommendationIds: ["diag-link-2-rec-0"],
      });

      await checkEvolutionHealth();

      expect(updateRecOutcomeCalls).toHaveLength(1);
      expect(updateRecOutcomeCalls[0]).toEqual({
        diagnosisId: "diag-link-2",
        recommendationId: "diag-link-2-rec-0",
        outcome: "effective",
      });
    });

    it("does not call updateRecommendationOutcome when no diagnosis is linked", async () => {
      mockMemory.current.evolutions = [
        {
          appliedAt: new Date().toISOString(),
          source: "adaptive",
          trigger: "heuristic",
          changes: [],
          outcome: "pending",
        },
      ];
      await startEvolutionObservation({
        appliedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
        rollbackChanges: [],
        windowMs: 60 * 60_000,
      });

      await checkEvolutionHealth();

      // No recommendation IDs linked, so no calls
      expect(updateRecOutcomeCalls).toHaveLength(0);
    });
  });
});
