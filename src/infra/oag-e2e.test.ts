import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared in-memory file system for all OAG modules
const memoryFiles = vi.hoisted(() => new Map<string, string>());

const configState = vi.hoisted(() => ({
  current: {
    gateway: {
      oag: {
        delivery: { recoveryBudgetMs: 60_000, maxRetries: 5 },
        lock: { timeoutMs: 2_000, staleMs: 30_000 },
        health: { stalePollFactor: 2 },
        notes: { dedupWindowMs: 60_000, maxDeliveredHistory: 20 },
        evolution: { autoApply: true },
      },
    },
  } as Record<string, unknown>,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => JSON.parse(JSON.stringify(configState.current)),
  writeConfigFile: vi.fn(async (cfg: unknown) => {
    configState.current = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  }),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/oag-e2e-test",
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async (p: string) => {
      if (!memoryFiles.has(p)) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return memoryFiles.get(p) ?? "";
    }),
    writeFile: vi.fn(async (p: string, content: string) => {
      memoryFiles.set(p, content);
    }),
    rename: vi.fn(async (src: string, dest: string) => {
      const content = memoryFiles.get(src);
      if (content !== undefined) {
        memoryFiles.set(dest, content);
        memoryFiles.delete(src);
      }
    }),
    mkdir: vi.fn(async () => {}),
    copyFile: vi.fn(async (src: string, dest: string) => {
      const content = memoryFiles.get(src);
      if (content !== undefined) {
        memoryFiles.set(dest, content);
      }
    }),
    open: vi.fn(async () => ({
      writeFile: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    })),
    unlink: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ mtimeMs: Date.now() })),
  },
}));

vi.mock("../config/sessions.js", () => ({
  resolveAgentIdFromSessionKey: () => "default",
  resolveDefaultSessionStorePath: () => "/tmp/oag-e2e-sessions.json",
  resolveSessionFilePath: () => "/tmp/oag-e2e-transcript.jsonl",
  loadSessionStore: () => ({}),
}));

// Import modules under test after all mocks
const { recordLifecycleShutdown, loadOagMemory, saveOagMemory, recordEvolution } =
  await import("./oag-memory.js");
const { recordOagIncident, collectActiveIncidents, clearActiveIncidents } =
  await import("./oag-incident-collector.js");
const { incrementOagMetric, getOagMetrics, resetOagMetrics } = await import("./oag-metrics.js");
const { runPostRecoveryAnalysis } = await import("./oag-postmortem.js");
const { startEvolutionObservation, checkEvolutionHealth, clearObservation } =
  await import("./oag-evolution-guard.js");
const { consumePendingOagSystemNotes } = await import("./oag-system-events.js");

describe("OAG E2E pipeline tests", () => {
  beforeEach(async () => {
    memoryFiles.clear();
    resetOagMetrics();
    clearActiveIncidents();
    await clearObservation();
    configState.current = {
      gateway: {
        oag: {
          delivery: { recoveryBudgetMs: 60_000, maxRetries: 5 },
          lock: { timeoutMs: 2_000, staleMs: 30_000 },
          health: { stalePollFactor: 2 },
          notes: { dedupWindowMs: 60_000, maxDeliveredHistory: 20 },
          evolution: { autoApply: true },
        },
      },
    };
  });

  describe("Test 1: Crash -> Recovery -> Evolution cycle", () => {
    it("full pipeline from crash incidents to confirmed evolution", async () => {
      const now = new Date().toISOString();

      // Step 1: Record 3 crash incidents via recordOagIncident
      recordOagIncident({
        type: "channel_crash_loop",
        channel: "telegram",
        detail: "ETIMEDOUT",
      });
      recordOagIncident({
        type: "channel_crash_loop",
        channel: "telegram",
        detail: "ECONNRESET",
      });
      recordOagIncident({
        type: "delivery_recovery_failure",
        channel: "discord",
        detail: "max retries exceeded",
      });

      const activeIncidents = collectActiveIncidents();
      expect(activeIncidents.length).toBeGreaterThanOrEqual(2);

      // Step 2: Record lifecycle shutdowns with recurring crash patterns
      // Need at least 2 crashes and 3+ occurrences of a pattern for postmortem to act
      for (let i = 0; i < 4; i++) {
        await recordLifecycleShutdown({
          startedAt: Date.now() - 60_000,
          stopReason: "crash",
          metricsSnapshot: getOagMetrics(),
          incidents: [
            {
              type: "channel_crash_loop",
              channel: "telegram",
              detail: "ETIMEDOUT",
              count: 1,
              firstAt: now,
              lastAt: now,
            },
          ],
        });
      }

      // Step 3: Call runPostRecoveryAnalysis
      const postmortem = await runPostRecoveryAnalysis();

      // Step 4: Verify recommendation generated, config change suggested
      expect(postmortem.analyzed).toBe(true);
      expect(postmortem.crashCount).toBeGreaterThanOrEqual(2);
      expect(postmortem.recommendations.length).toBeGreaterThan(0);
      expect(postmortem.applied.length).toBeGreaterThan(0);
      const appliedRec = postmortem.applied[0];
      expect(appliedRec.configPath).toContain("gateway.oag");
      expect(appliedRec.suggestedValue).toBeGreaterThan(appliedRec.currentValue);

      // Step 5: Verify evolution was recorded and observation started
      const memoryAfterPostmortem = await loadOagMemory();
      expect(memoryAfterPostmortem.evolutions.length).toBeGreaterThan(0);
      const lastEvolution =
        memoryAfterPostmortem.evolutions[memoryAfterPostmortem.evolutions.length - 1];
      expect(lastEvolution.source).toBe("adaptive");
      expect(lastEvolution.outcome).toBe("pending");
      expect(memoryAfterPostmortem.activeObservation).not.toBeNull();

      // Step 6: Simulate time passing by starting a new observation with an old timestamp
      // (the observation window is 1 hour by default)
      await clearObservation();
      await startEvolutionObservation({
        appliedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), // 2 hours ago
        rollbackChanges: [],
        windowMs: 60 * 60_000, // 1 hour window
      });

      // Step 7: checkEvolutionHealth with no regression
      const healthResult = await checkEvolutionHealth();
      expect(healthResult.checked).toBe(true);
      expect(healthResult.action).toBe("confirmed");

      // Step 8: Verify evolution marked "effective" in memory
      const finalMemory = await loadOagMemory();
      const confirmedEvolution = finalMemory.evolutions[finalMemory.evolutions.length - 1];
      expect(confirmedEvolution.outcome).toBe("effective");
    });
  });

  describe("Test 2: Evolution rollback on regression", () => {
    it("reverts config when regression is detected after evolution", async () => {
      const originalBudget = 60_000;
      const evolvedBudget = 90_000;

      // Step 1: Apply evolution via postmortem simulation
      await recordEvolution({
        appliedAt: new Date().toISOString(),
        source: "adaptive",
        trigger: "post-recovery analysis (4 crashes in 48h)",
        changes: [
          {
            configPath: "gateway.oag.delivery.recoveryBudgetMs",
            from: originalBudget,
            to: evolvedBudget,
          },
        ],
        outcome: "pending",
      });

      // Step 2: Start observation with rollback info
      await startEvolutionObservation({
        appliedAt: new Date().toISOString(),
        rollbackChanges: [
          {
            configPath: "gateway.oag.delivery.recoveryBudgetMs",
            previousValue: originalBudget,
          },
        ],
      });

      // Step 3: Simulate regression (increment channelRestarts 6 times, threshold is >=5)
      for (let i = 0; i < 6; i++) {
        incrementOagMetric("channelRestarts");
      }

      // Step 4: Call checkEvolutionHealth
      const result = await checkEvolutionHealth();

      // Step 5: Verify config reverted
      expect(result.checked).toBe(true);
      expect(result.action).toBe("reverted");
      expect(result.reason).toContain("channel restarts spiked");

      // Verify evolution record marked as reverted
      const memory = await loadOagMemory();
      const lastEvolution = memory.evolutions[memory.evolutions.length - 1];
      expect(lastEvolution.outcome).toBe("reverted");
      expect(lastEvolution.outcomeAt).toBeDefined();

      // Verify observation cleared
      expect(memory.activeObservation).toBeNull();
    });

    it("also reverts on delivery recovery failure spike", async () => {
      await recordEvolution({
        appliedAt: new Date().toISOString(),
        source: "adaptive",
        trigger: "test",
        changes: [
          {
            configPath: "gateway.oag.delivery.maxRetries",
            from: 5,
            to: 7,
          },
        ],
        outcome: "pending",
      });

      await startEvolutionObservation({
        appliedAt: new Date().toISOString(),
        rollbackChanges: [{ configPath: "gateway.oag.delivery.maxRetries", previousValue: 5 }],
      });

      // Spike delivery recovery failures past threshold (>=3)
      for (let i = 0; i < 4; i++) {
        incrementOagMetric("deliveryRecoveryFailures");
      }

      const result = await checkEvolutionHealth();
      expect(result.action).toBe("reverted");
      expect(result.reason).toContain("delivery recovery failures spiked");
    });
  });

  describe("Test 3: Notification dedup + localization", () => {
    it("deduplicates notes with same action within dedup window", async () => {
      const statePath = `${process.env.HOME}/.openclaw/sentinel/channel-health-state.json`;
      const baseTime = Date.now();
      const sessionKey = "test-session-key";

      // Step 1: Create 3 notes with same action within dedup window (60s default)
      const pendingNotes = [
        {
          id: "oag-evolution:ev-1",
          action: "oag_evolution",
          created_at: new Date(baseTime - 10_000).toISOString(),
          message: "I analyzed recent incidents and adjusted recovery parameters.",
          targets: [{ sessionKeys: [sessionKey] }],
        },
        {
          id: "oag-evolution:ev-2",
          action: "oag_evolution",
          created_at: new Date(baseTime - 5_000).toISOString(),
          message: "I analyzed recent incidents and adjusted recovery parameters.",
          targets: [{ sessionKeys: [sessionKey] }],
        },
        {
          id: "oag-evolution:ev-3",
          action: "oag_evolution",
          created_at: new Date(baseTime).toISOString(),
          message: "I analyzed recent incidents and adjusted recovery parameters.",
          targets: [{ sessionKeys: [sessionKey] }],
        },
      ];

      memoryFiles.set(statePath, JSON.stringify({ pending_user_notes: pendingNotes }));

      // Step 2: Call consumeOagNotes with session key
      const consumed = await consumePendingOagSystemNotes(sessionKey);

      // Step 3: Verify only 1 note consumed (newest, since all 3 are within dedup window)
      expect(consumed).toHaveLength(1);

      // Step 4: Verify the note has the OAG prefix and is in English (default)
      expect(consumed[0].text).toContain("OAG:");
      // The localized English version of oag_evolution action
      expect(consumed[0].text).toContain("analyzed recent incidents");
    });
  });

  describe("Test 4: Incident collector overflow", () => {
    it("retains only 1000 incidents and evicts oldest", () => {
      // Step 1: Record 1005 incidents with unique keys (MAX_ACTIVE_INCIDENTS = 1000)
      for (let i = 0; i < 1005; i++) {
        recordOagIncident({
          type: "stale_detection",
          channel: `channel-${String(i).padStart(4, "0")}`,
          detail: `incident-${i}`,
        });
      }

      // Step 2: Verify only 1000 retained
      const incidents = collectActiveIncidents();
      expect(incidents).toHaveLength(1000);

      // Step 3: Verify oldest 5 were evicted
      const channels = incidents.map((inc) => inc.channel);
      for (let i = 0; i < 5; i++) {
        expect(channels).not.toContain(`channel-${String(i).padStart(4, "0")}`);
      }

      // Step 4: Verify newest 1000 present
      for (let i = 5; i < 1005; i++) {
        expect(channels).toContain(`channel-${String(i).padStart(4, "0")}`);
      }
    });
  });

  describe("Test 5: Memory persistence across simulated restarts", () => {
    it("saves and restores all data correctly with old lifecycle pruning", async () => {
      const now = new Date().toISOString();
      const recentDate = new Date().toISOString();
      const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60_000).toISOString(); // 40 days ago

      // Step 1: Record lifecycle + incidents + evolution
      await recordLifecycleShutdown({
        startedAt: Date.now() - 60_000,
        stopReason: "crash",
        metricsSnapshot: { channelRestarts: 5 },
        incidents: [
          {
            type: "channel_crash_loop",
            channel: "telegram",
            detail: "test",
            count: 1,
            firstAt: now,
            lastAt: now,
          },
        ],
      });

      await recordEvolution({
        appliedAt: recentDate,
        source: "adaptive",
        trigger: "post-recovery analysis",
        changes: [
          { configPath: "gateway.oag.delivery.recoveryBudgetMs", from: 60_000, to: 90_000 },
        ],
        outcome: "effective",
        outcomeAt: recentDate,
      });

      // Step 2: Save memory — this is implicit from the record calls.
      // Add an old lifecycle manually to test pruning.
      const memory = await loadOagMemory();
      memory.lifecycles.unshift({
        id: "gw-old",
        startedAt: oldDate,
        stoppedAt: oldDate,
        stopReason: "crash",
        uptimeMs: 60_000,
        metricsSnapshot: {},
        incidents: [],
      });
      await saveOagMemory(memory);

      // Step 3: Verify the saved state has both lifecycles
      const savedMemory = await loadOagMemory();
      expect(savedMemory.lifecycles.length).toBeGreaterThanOrEqual(2);
      expect(savedMemory.evolutions).toHaveLength(1);

      // Step 4: Simulate restart by triggering a new lifecycle shutdown
      // (pruneOldLifecycles runs during recordLifecycleShutdown)
      await recordLifecycleShutdown({
        startedAt: Date.now() - 30_000,
        stopReason: "clean",
        metricsSnapshot: {},
        incidents: [],
      });

      // Step 5: Verify old lifecycles (>30 days) pruned
      const prunedMemory = await loadOagMemory();
      const oldLifecycle = prunedMemory.lifecycles.find((lc) => lc.id === "gw-old");
      expect(oldLifecycle).toBeUndefined();

      // Recent lifecycles should still be present
      expect(prunedMemory.lifecycles.length).toBeGreaterThanOrEqual(1);
      const recentIds = prunedMemory.lifecycles.map((lc) => lc.id);
      expect(recentIds.some((id) => id !== "gw-old")).toBe(true);

      // Evolution data should be preserved
      expect(prunedMemory.evolutions).toHaveLength(1);
      expect(prunedMemory.evolutions[0].source).toBe("adaptive");
      expect(prunedMemory.evolutions[0].outcome).toBe("effective");
    });

    it("round-trips memory through save and load", async () => {
      const memory = await loadOagMemory();
      expect(memory.version).toBe(1);

      memory.lifecycles.push({
        id: "gw-roundtrip",
        startedAt: new Date().toISOString(),
        stoppedAt: new Date().toISOString(),
        stopReason: "clean",
        uptimeMs: 5000,
        metricsSnapshot: { channelRestarts: 1 },
        incidents: [],
      });

      memory.evolutions.push({
        appliedAt: new Date().toISOString(),
        source: "operator",
        trigger: "manual adjustment",
        changes: [{ configPath: "gateway.oag.lock.staleMs", from: 30_000, to: 45_000 }],
        outcome: "effective",
      });

      memory.diagnoses.push({
        id: "diag-roundtrip",
        triggeredAt: new Date().toISOString(),
        trigger: "recurring_pattern",
        rootCause: "Rate limiting by upstream provider",
        confidence: 0.92,
        recommendations: [
          {
            type: "config_change",
            description: "Increase recovery budget",
            configPath: "gateway.oag.delivery.recoveryBudgetMs",
            suggestedValue: 90_000,
            risk: "low",
            applied: false,
          },
        ],
        completedAt: new Date().toISOString(),
      });

      await saveOagMemory(memory);

      const restored = await loadOagMemory();
      expect(restored.version).toBe(1);
      expect(restored.lifecycles).toHaveLength(1);
      expect(restored.lifecycles[0].id).toBe("gw-roundtrip");
      expect(restored.evolutions).toHaveLength(1);
      expect(restored.evolutions[0].source).toBe("operator");
      expect(restored.diagnoses).toHaveLength(1);
      expect(restored.diagnoses[0].rootCause).toBe("Rate limiting by upstream provider");
      expect(restored.diagnoses[0].confidence).toBe(0.92);
    });
  });
});
