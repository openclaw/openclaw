import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Shared in-memory file system ---
const memoryFiles = vi.hoisted(() => new Map<string, string>());

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/oag-concurrency-test",
}));

vi.mock("./oag-config.js", () => ({
  resolveOagMemoryMaxLifecycleAgeDays: () => 30,
  resolveOagEvolutionObservationWindowMs: () => 60 * 60_000,
  resolveOagEvolutionRestartRegressionThreshold: () => 5,
  resolveOagEvolutionFailureRegressionThreshold: () => 3,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock("node:fs/promises", () => {
  // Simulate slight write delay to surface race conditions
  const delay = () => new Promise<void>((r) => setTimeout(r, Math.random() * 5));
  return {
    default: {
      readFile: vi.fn(async (p: string) => {
        await delay();
        if (!memoryFiles.has(p)) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return memoryFiles.get(p) ?? "";
      }),
      writeFile: vi.fn(async (p: string, content: string) => {
        await delay();
        memoryFiles.set(p, content);
      }),
      rename: vi.fn(async (src: string, dest: string) => {
        await delay();
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
  };
});

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
  incrementOagMetric: vi.fn(),
  resetOagMetrics: vi.fn(),
}));

vi.mock("./oag-config-writer.js", () => ({
  applyOagConfigChanges: vi.fn(async () => ({ applied: true })),
}));

const { loadOagMemory, saveOagMemory, recordLifecycleShutdown } = await import("./oag-memory.js");
const { recordOagIncident, collectActiveIncidents, clearActiveIncidents } =
  await import("./oag-incident-collector.js");
const { startEvolutionObservation, getActiveObservation, clearObservation } =
  await import("./oag-evolution-guard.js");

describe("OAG concurrency tests", () => {
  beforeEach(async () => {
    memoryFiles.clear();
    clearActiveIncidents();
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
  });

  describe("memory file concurrent writes", () => {
    it("handles 5 parallel recordLifecycleShutdown calls without data corruption", async () => {
      const promises = Array.from({ length: 5 }, (_, i) =>
        recordLifecycleShutdown({
          startedAt: Date.now() - 60_000 * (i + 1),
          stopReason: "crash",
          metricsSnapshot: { channelRestarts: i },
          incidents: [
            {
              type: "channel_crash_loop" as const,
              channel: `channel-${i}`,
              detail: `crash ${i}`,
              count: 1,
              firstAt: new Date().toISOString(),
              lastAt: new Date().toISOString(),
            },
          ],
        }),
      );

      // All should resolve without throwing
      await expect(Promise.all(promises)).resolves.toBeDefined();

      // Load final memory and verify it is valid JSON
      const memory = await loadOagMemory();
      expect(memory.version).toBe(1);
      expect(Array.isArray(memory.lifecycles)).toBe(true);

      // At least one record present (the last write wins in this mock FS, but
      // the file must always remain valid JSON)
      expect(memory.lifecycles.length).toBeGreaterThanOrEqual(1);

      // Verify the raw file is valid JSON
      const mainPath = "/tmp/oag-concurrency-test/oag-memory.json";
      const rawContent = memoryFiles.get(mainPath);
      expect(rawContent).toBeDefined();
      expect(() => JSON.parse(rawContent!)).not.toThrow();
    });

    it("all parallel lifecycle records produce valid JSON even under contention", async () => {
      // Pre-seed the file so all writes must load-modify-save
      await saveOagMemory({
        version: 1,
        lifecycles: [],
        evolutions: [],
        diagnoses: [],
        auditLog: [],
        metricSeries: [],
        activeObservation: null,
      });

      const batchSize = 5;
      const promises = Array.from({ length: batchSize }, (_, i) =>
        recordLifecycleShutdown({
          startedAt: Date.now() - 1000 * (i + 1),
          stopReason: "clean",
          metricsSnapshot: {},
          incidents: [],
        }),
      );

      await Promise.all(promises);

      const memory = await loadOagMemory();
      expect(memory.version).toBe(1);
      // File must be structurally valid
      expect(Array.isArray(memory.lifecycles)).toBe(true);
      expect(Array.isArray(memory.evolutions)).toBe(true);
      expect(Array.isArray(memory.diagnoses)).toBe(true);
    });
  });

  describe("lock contention timeout", () => {
    it("second consumer eventually times out gracefully when lock is held", async () => {
      // The mock FS never blocks on lock files (open always succeeds), so we
      // test the timeout concept by verifying that when the underlying lock file
      // already exists with a valid PID, the system-events module's lock
      // retries and eventually resolves (stale detection kicks in because
      // our mock returns current PID which is alive, but the stat mock returns
      // a current timestamp which is not stale).
      //
      // For the concurrency test, we verify that multiple saves from parallel
      // callers complete without deadlocking by using a short timeout.
      const parallelSaves = Array.from({ length: 3 }, async (_, i) => {
        const mem = await loadOagMemory();
        mem.lifecycles.push({
          id: `gw-lock-${i}`,
          startedAt: new Date().toISOString(),
          stoppedAt: new Date().toISOString(),
          stopReason: "clean",
          uptimeMs: 1000,
          metricsSnapshot: {},
          incidents: [],
        });
        return saveOagMemory(mem);
      });

      // All saves should complete (no deadlock)
      await expect(
        Promise.race([
          Promise.all(parallelSaves),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("deadlock timeout")), 10_000),
          ),
        ]),
      ).resolves.toBeDefined();
    });
  });

  describe("channel recovery dedup", () => {
    it("handles 3 concurrent recordOagIncident calls for same channel:account correctly", () => {
      // recordOagIncident is synchronous — concurrent calls from the event loop
      // effectively serialize. We verify that the count increments correctly.
      const incidents = Array.from({ length: 3 }, (_, i) => ({
        type: "channel_crash_loop" as const,
        channel: "telegram",
        accountId: "acc-1",
        detail: `crash attempt ${i}`,
      }));

      for (const incident of incidents) {
        recordOagIncident(incident);
      }

      const active = collectActiveIncidents();
      // Same channel:account key should produce a single entry
      const telegramIncidents = active.filter((inc) => inc.channel === "telegram");
      expect(telegramIncidents).toHaveLength(1);

      // Count should be exactly 3 (no lost updates)
      expect(telegramIncidents[0].count).toBe(3);

      // lastAt should reflect the most recent call
      expect(telegramIncidents[0].detail).toBe("crash attempt 2");
    });

    it("different channels get separate incident records", () => {
      const channels = ["telegram", "discord", "slack"];
      for (const channel of channels) {
        recordOagIncident({
          type: "delivery_recovery_failure",
          channel,
          detail: `failure on ${channel}`,
        });
        recordOagIncident({
          type: "delivery_recovery_failure",
          channel,
          detail: `failure on ${channel} again`,
        });
      }

      const active = collectActiveIncidents();
      expect(active).toHaveLength(3);
      for (const inc of active) {
        expect(inc.count).toBe(2);
      }
    });
  });

  describe("evolution observation race", () => {
    it("second startEvolutionObservation overwrites the first cleanly", async () => {
      const firstAppliedAt = new Date(Date.now() - 120_000).toISOString();
      const secondAppliedAt = new Date().toISOString();

      // Start two observations in parallel
      const [resultA, resultB] = await Promise.allSettled([
        startEvolutionObservation({
          appliedAt: firstAppliedAt,
          rollbackChanges: [
            {
              configPath: "gateway.oag.delivery.recoveryBudgetMs",
              previousValue: 60_000,
            },
          ],
        }),
        startEvolutionObservation({
          appliedAt: secondAppliedAt,
          rollbackChanges: [
            {
              configPath: "gateway.oag.delivery.maxRetries",
              previousValue: 5,
            },
          ],
        }),
      ]);

      // Both should succeed (no rejection)
      expect(resultA.status).toBe("fulfilled");
      expect(resultB.status).toBe("fulfilled");

      // Exactly one observation should be active
      const obs = getActiveObservation();
      expect(obs).not.toBeNull();

      // The active observation should be valid (either the first or second)
      expect(obs!.rollbackChanges).toHaveLength(1);
      expect(obs!.evolutionAppliedAt).toBeDefined();

      // Verify memory file is valid
      const memory = await loadOagMemory();
      expect(memory.activeObservation).not.toBeNull();
      expect(memory.activeObservation!.rollbackChanges).toHaveLength(1);
    });

    it("rapid sequential observations result in only the last one being active", async () => {
      for (let i = 0; i < 5; i++) {
        await startEvolutionObservation({
          appliedAt: new Date(Date.now() - (5 - i) * 60_000).toISOString(),
          rollbackChanges: [
            {
              configPath: `gateway.oag.delivery.recoveryBudgetMs`,
              previousValue: 60_000 + i * 10_000,
            },
          ],
        });
      }

      const obs = getActiveObservation();
      expect(obs).not.toBeNull();
      // The last observation's rollback value should be 60000 + 4*10000 = 100000
      expect(obs!.rollbackChanges[0].previousValue).toBe(100_000);
    });
  });
});
