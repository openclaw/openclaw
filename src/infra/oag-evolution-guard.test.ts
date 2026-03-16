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
vi.mock("./oag-memory.js", () => ({
  loadOagMemory: vi.fn(async () => ({
    ...mockMemory.current,
    evolutions: [...mockMemory.current.evolutions],
  })),
  saveOagMemory: vi.fn(async (m: unknown) => {
    mockMemory.current = m as typeof mockMemory.current;
  }),
}));

const { startEvolutionObservation, checkEvolutionHealth, clearObservation } =
  await import("./oag-evolution-guard.js");

describe("oag-evolution-guard", () => {
  beforeEach(() => {
    clearObservation();
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
    startEvolutionObservation({
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
    startEvolutionObservation({
      appliedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), // 2 hours ago
      rollbackChanges: [],
      windowMs: 60 * 60_000,
    });
    const result = await checkEvolutionHealth();
    expect(result.action).toBe("confirmed");
  });

  it("returns none during active observation with no regression", async () => {
    startEvolutionObservation({
      appliedAt: new Date().toISOString(),
      rollbackChanges: [],
    });
    const result = await checkEvolutionHealth();
    expect(result.action).toBe("none");
    expect(result.checked).toBe(true);
  });
});
