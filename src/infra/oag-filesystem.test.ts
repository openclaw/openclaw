import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OagLifecycle, OagMemory } from "./oag-memory.js";

// Only mock config loading — real FS operations are used throughout
vi.mock("../config/config.js", () => ({
  loadConfig: () => ({
    gateway: {
      oag: {
        delivery: { recoveryBudgetMs: 60_000, maxRetries: 5 },
        lock: { timeoutMs: 2_000, staleMs: 30_000 },
        health: { stalePollFactor: 2 },
        notes: { dedupWindowMs: 60_000, maxDeliveredHistory: 20 },
      },
    },
  }),
  writeConfigFile: vi.fn(async (cfg: unknown) => {
    // Write to a temp path to test atomicity below
    const configDir = writtenConfigDir;
    if (configDir) {
      const configPath = path.join(configDir, "openclaw.json");
      const tmp = `${configPath}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      await fsp.rename(tmp, configPath);
    }
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

let tmpDir: string;
let writtenConfigDir: string | null = null;

// We must dynamically mock resolveStateDir so it points to our tmpDir
// before importing any OAG modules
let stateDir = "/tmp/oag-fs-test-placeholder";
vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => stateDir,
}));

vi.mock("./oag-config.js", () => ({
  resolveOagMemoryMaxLifecycleAgeDays: () => 30,
  resolveOagLockTimeoutMs: () => 2_000,
  resolveOagLockStaleMs: () => 30_000,
  resolveOagMaxDeliveredNotes: () => 20,
  resolveOagNoteDedupWindowMs: () => 60_000,
  resolveOagEvolutionObservationWindowMs: () => 60 * 60_000,
}));

vi.mock("./oag-metrics.js", () => ({
  incrementOagMetric: vi.fn(),
  getOagMetrics: () => ({
    channelRestarts: 0,
    deliveryRecoveryFailures: 0,
    deliveryRecoveries: 0,
    staleSocketDetections: 0,
    stalePollDetections: 0,
    noteDeliveries: 0,
    noteDeduplications: 0,
    lockAcquisitions: 0,
    lockStalRecoveries: 0,
  }),
  resetOagMetrics: vi.fn(),
}));

// Import OAG modules after mocks
const { loadOagMemory, saveOagMemory, recordLifecycleShutdown } = await import("./oag-memory.js");
const { addToIndex, queryIndex, rebuildIndex, getIndexSize } =
  await import("./outbound/delivery-index.js");
const { applyOagConfigChanges } = await import("./oag-config-writer.js");

describe("OAG real filesystem tests", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oag-fs-test-"));
    stateDir = tmpDir;
    writtenConfigDir = null;
  });

  afterEach(async () => {
    writtenConfigDir = null;
    // Clean up the temp directory
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  describe("memory backup/restore round-trip", () => {
    it("writes memory to a real temp dir then recovers from backup after corruption", async () => {
      // Step 1: Write OAG memory with real data
      const memory = {
        version: 1 as const,
        lifecycles: [
          {
            id: "gw-backup-test",
            startedAt: "2026-03-17T00:00:00Z",
            stoppedAt: "2026-03-17T01:00:00Z",
            stopReason: "crash" as const,
            uptimeMs: 3_600_000,
            metricsSnapshot: { channelRestarts: 3 },
            incidents: [
              {
                type: "channel_crash_loop" as const,
                channel: "telegram",
                detail: "ETIMEDOUT",
                count: 2,
                firstAt: "2026-03-17T00:30:00Z",
                lastAt: "2026-03-17T00:45:00Z",
              },
            ],
          },
        ],
        evolutions: [
          {
            appliedAt: "2026-03-17T01:00:00Z",
            source: "adaptive" as const,
            trigger: "post-recovery analysis",
            changes: [
              {
                configPath: "gateway.oag.delivery.recoveryBudgetMs",
                from: 60_000,
                to: 90_000,
              },
            ],
            outcome: "effective" as const,
          },
        ],
        diagnoses: [],
        auditLog: [],
        metricSeries: [],
        activeObservation: null,
      };

      await saveOagMemory(memory);

      // Verify main file exists
      const mainPath = path.join(tmpDir, "oag-memory.json");
      const mainExists = fs.existsSync(mainPath);
      expect(mainExists).toBe(true);

      // Step 2: Save again to create the .bak backup
      await saveOagMemory(memory);
      const bakPath = `${mainPath}.bak`;
      const bakExists = fs.existsSync(bakPath);
      expect(bakExists).toBe(true);

      // Step 3: Corrupt the main file (truncate halfway)
      const originalContent = await fsp.readFile(mainPath, "utf8");
      const truncated = originalContent.slice(0, Math.floor(originalContent.length / 2));
      await fsp.writeFile(mainPath, truncated, "utf8");

      // Verify main file is now corrupt
      expect(() => JSON.parse(truncated)).toThrow();

      // Step 4: Load and verify backup is used
      const recovered = await loadOagMemory();
      expect(recovered.version).toBe(1);
      expect(recovered.lifecycles).toHaveLength(1);
      expect(recovered.lifecycles[0].id).toBe("gw-backup-test");
      expect(recovered.lifecycles[0].incidents).toHaveLength(1);
      expect(recovered.evolutions).toHaveLength(1);
      expect(recovered.evolutions[0].source).toBe("adaptive");
    });

    it("returns empty memory when both main and backup are missing", async () => {
      const memory = await loadOagMemory();
      expect(memory.version).toBe(1);
      expect(memory.lifecycles).toEqual([]);
      expect(memory.evolutions).toEqual([]);
      expect(memory.diagnoses).toEqual([]);
    });

    it("returns empty memory when both main and backup are corrupt", async () => {
      const mainPath = path.join(tmpDir, "oag-memory.json");
      const bakPath = `${mainPath}.bak`;
      await fsp.mkdir(path.dirname(mainPath), { recursive: true });
      await fsp.writeFile(mainPath, "NOT_JSON{{{", "utf8");
      await fsp.writeFile(bakPath, "ALSO_BROKEN{", "utf8");

      const memory = await loadOagMemory();
      expect(memory.version).toBe(1);
      expect(memory.lifecycles).toEqual([]);
    });
  });

  describe("delivery index persistence", () => {
    it("creates 100 entries, queries by channel, and rebuilds index", async () => {
      // Create the delivery-queue directory
      const queueDir = path.join(tmpDir, "delivery-queue");
      await fsp.mkdir(queueDir, { recursive: true });

      // Step 1: Create 100 delivery index entries
      const channels = ["telegram", "discord", "slack", "signal", "whatsapp"];
      for (let i = 0; i < 100; i++) {
        const channel = channels[i % channels.length];
        const entry = {
          id: `delivery-${String(i).padStart(3, "0")}`,
          channel,
          accountId: i % 2 === 0 ? "acc-1" : "acc-2",
          enqueuedAt: Date.now() - (100 - i) * 1000,
          lanePriority: i % 3 === 0 ? "system" : "user-visible",
        };
        await addToIndex(entry, tmpDir);

        // Also write individual delivery files for rebuild test
        await fsp.writeFile(path.join(queueDir, `${entry.id}.json`), JSON.stringify(entry), "utf8");
      }

      // Step 2: Verify index size
      const size = await getIndexSize(tmpDir);
      expect(size).toBe(100);

      // Step 3: Query by channel filter
      const telegramEntries = await queryIndex({ channel: "telegram" }, tmpDir);
      // 100 entries / 5 channels = 20 per channel
      expect(telegramEntries).toHaveLength(20);
      for (const entry of telegramEntries) {
        expect(entry.channel).toBe("telegram");
      }

      // Verify sorted by enqueuedAt
      for (let i = 1; i < telegramEntries.length; i++) {
        expect(telegramEntries[i].enqueuedAt).toBeGreaterThanOrEqual(
          telegramEntries[i - 1].enqueuedAt,
        );
      }

      const discordEntries = await queryIndex({ channel: "discord" }, tmpDir);
      expect(discordEntries).toHaveLength(20);

      // Step 4: Rebuild index from delivery files
      const rebuiltCount = await rebuildIndex(tmpDir);
      expect(rebuiltCount).toBe(100);

      // Step 5: Verify rebuilt index matches reality
      const rebuiltSize = await getIndexSize(tmpDir);
      expect(rebuiltSize).toBe(100);

      const rebuiltTelegram = await queryIndex({ channel: "telegram" }, tmpDir);
      expect(rebuiltTelegram).toHaveLength(20);
    });

    it("rebuild handles empty queue directory gracefully", async () => {
      const queueDir = path.join(tmpDir, "delivery-queue");
      await fsp.mkdir(queueDir, { recursive: true });

      const count = await rebuildIndex(tmpDir);
      expect(count).toBe(0);

      const size = await getIndexSize(tmpDir);
      expect(size).toBe(0);
    });

    it("rebuild skips malformed delivery files", async () => {
      const queueDir = path.join(tmpDir, "delivery-queue");
      await fsp.mkdir(queueDir, { recursive: true });

      // Write one valid and one malformed file
      await fsp.writeFile(
        path.join(queueDir, "valid.json"),
        JSON.stringify({
          id: "valid-1",
          channel: "telegram",
          enqueuedAt: Date.now(),
          lanePriority: "user-visible",
        }),
        "utf8",
      );
      await fsp.writeFile(path.join(queueDir, "broken.json"), "NOT_VALID_JSON{{{", "utf8");

      const count = await rebuildIndex(tmpDir);
      expect(count).toBe(1);
    });
  });

  describe("lock file lifecycle", () => {
    it("creates and releases a real lock file in temp dir", async () => {
      const lockDir = path.join(tmpDir, "locks");
      await fsp.mkdir(lockDir, { recursive: true });

      const lockPath = path.join(lockDir, "test.lock");

      // Step 1: Create a lock file
      const fd = await fsp.open(lockPath, "wx");
      await fd.writeFile(String(process.pid), "utf8");

      // Step 2: Verify lock file exists
      expect(fs.existsSync(lockPath)).toBe(true);

      // Step 3: Verify second open with "wx" fails (file already exists)
      await expect(fsp.open(lockPath, "wx")).rejects.toThrow();

      // Step 4: Read lock content to verify PID was written
      const content = await fsp.readFile(lockPath, "utf8");
      expect(content.trim()).toBe(String(process.pid));

      // Step 5: Release the lock
      await fd.close();
      await fsp.unlink(lockPath);

      // Step 6: Verify lock file is removed
      expect(fs.existsSync(lockPath)).toBe(false);

      // Step 7: Verify second lock attempt now succeeds
      const fd2 = await fsp.open(lockPath, "wx");
      await fd2.writeFile(String(process.pid), "utf8");
      expect(fs.existsSync(lockPath)).toBe(true);

      // Cleanup
      await fd2.close();
      await fsp.unlink(lockPath);
    });

    it("lock file with stale PID is detected", async () => {
      const lockDir = path.join(tmpDir, "locks");
      await fsp.mkdir(lockDir, { recursive: true });

      const lockPath = path.join(lockDir, "stale.lock");

      // Write a lock file with a PID that almost certainly does not exist
      // (use a very high PID number)
      const stalePid = 9999999;
      await fsp.writeFile(lockPath, String(stalePid), "utf8");

      // Verify the file exists
      expect(fs.existsSync(lockPath)).toBe(true);

      // Read it back and verify the stale PID
      const content = await fsp.readFile(lockPath, "utf8");
      const pid = Number.parseInt(content.trim(), 10);
      expect(pid).toBe(stalePid);

      // Verify: process.kill(stalePid, 0) should throw (process does not exist)
      let processExists = true;
      try {
        process.kill(stalePid, 0);
      } catch {
        processExists = false;
      }
      expect(processExists).toBe(false);

      // Cleanup: remove stale lock
      await fsp.unlink(lockPath);

      // New lock should succeed after stale cleanup
      const fd = await fsp.open(lockPath, "wx");
      await fd.writeFile(String(process.pid), "utf8");
      expect(fs.existsSync(lockPath)).toBe(true);

      await fd.close();
      await fsp.unlink(lockPath);
    });
  });

  describe("atomic write safety", () => {
    it("writes config via applyOagConfigChanges to a real temp dir atomically", async () => {
      // Set up writtenConfigDir so the mock writeConfigFile writes to our tmpDir
      writtenConfigDir = tmpDir;

      const result = await applyOagConfigChanges([
        { configPath: "gateway.oag.delivery.recoveryBudgetMs", value: 90_000 },
      ]);

      expect(result.applied).toBe(true);

      // Step 1: Verify final file is valid JSON
      const configPath = path.join(tmpDir, "openclaw.json");
      const rawContent = await fsp.readFile(configPath, "utf8");
      expect(() => JSON.parse(rawContent)).not.toThrow();

      // Step 2: Verify the written config has the expected value
      const parsed = JSON.parse(rawContent);
      expect(parsed.gateway.oag.delivery.recoveryBudgetMs).toBe(90_000);
      // Existing config values preserved
      expect(parsed.gateway.oag.delivery.maxRetries).toBe(5);

      // Step 3: Verify no orphan temp files
      const files = await fsp.readdir(tmpDir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });

    it("atomic save of OAG memory leaves no orphan temp files", async () => {
      const memory: OagMemory = {
        version: 1,
        lifecycles: [],
        evolutions: [],
        diagnoses: [],
        auditLog: [],
        metricSeries: [],
        activeObservation: null,
      };

      // Save multiple times to exercise the atomic write path
      for (let i = 0; i < 5; i++) {
        memory.lifecycles = [];
        for (let j = 0; j <= i; j++) {
          memory.lifecycles.push({
            id: `gw-atomic-${i}-${j}`,
            startedAt: new Date().toISOString(),
            stoppedAt: new Date().toISOString(),
            stopReason: "clean",
            uptimeMs: 1000,
            metricsSnapshot: {},
            incidents: [],
          } as OagLifecycle);
        }
        await saveOagMemory(memory);
      }

      // Verify the final file is valid JSON
      const mainPath = path.join(tmpDir, "oag-memory.json");
      const rawContent = await fsp.readFile(mainPath, "utf8");
      expect(() => JSON.parse(rawContent)).not.toThrow();

      // Verify no orphan .tmp files in the directory
      const files = await fsp.readdir(tmpDir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);

      // Verify the data is correct
      const loaded = await loadOagMemory();
      expect(loaded.lifecycles).toHaveLength(5);
    });

    it("recordLifecycleShutdown writes valid JSON to real filesystem", async () => {
      await recordLifecycleShutdown({
        startedAt: Date.now() - 120_000,
        stopReason: "crash",
        metricsSnapshot: { channelRestarts: 7 },
        incidents: [
          {
            type: "delivery_recovery_failure",
            channel: "discord",
            detail: "max retries exceeded",
            count: 3,
            firstAt: new Date().toISOString(),
            lastAt: new Date().toISOString(),
          },
        ],
      });

      // Verify file exists and is valid
      const mainPath = path.join(tmpDir, "oag-memory.json");
      expect(fs.existsSync(mainPath)).toBe(true);

      const rawContent = await fsp.readFile(mainPath, "utf8");
      const parsed = JSON.parse(rawContent);
      expect(parsed.version).toBe(1);
      expect(parsed.lifecycles).toHaveLength(1);
      expect(parsed.lifecycles[0].stopReason).toBe("crash");
      expect(parsed.lifecycles[0].incidents).toHaveLength(1);

      // No orphan temp files
      const files = await fsp.readdir(tmpDir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });
  });
});
