/**
 * Monitor Runner Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MonitorRunner,
  resetMonitorRunner,
  type ScanModule,
  type ScanFinding,
} from "./monitor-runner.js";
import { resetSecurityEventsManager } from "./security-events.js";

describe("MonitorRunner", () => {
  let runner: MonitorRunner;

  beforeEach(() => {
    resetMonitorRunner();
    resetSecurityEventsManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (runner) {
      runner.stop();
    }
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("should create runner with default config", () => {
      runner = new MonitorRunner();
      const status = runner.getStatus();

      expect(status.enabled).toBe(true);
      expect(status.running).toBe(false);
    });

    it("should respect disabled config", () => {
      runner = new MonitorRunner({ enabled: false });
      const status = runner.getStatus();

      expect(status.enabled).toBe(false);
    });
  });

  describe("registerModule", () => {
    it("should register scan modules", () => {
      runner = new MonitorRunner();

      const module: ScanModule = {
        name: "test-module",
        scan: async () => [],
      };

      runner.registerModule(module);

      // Module registration is internal, but we can verify via scan
      // No explicit getter, so this is a smoke test
    });
  });

  describe("start/stop", () => {
    it("should start the runner", () => {
      runner = new MonitorRunner({ runOnStart: false });
      runner.start();

      const status = runner.getStatus();
      expect(status.running).toBe(true);
      expect(status.nextScanAt).not.toBeNull();
    });

    it("should stop the runner", () => {
      runner = new MonitorRunner({ runOnStart: false });
      runner.start();
      runner.stop();

      const status = runner.getStatus();
      expect(status.running).toBe(false);
      expect(status.nextScanAt).toBeNull();
    });

    it("should not start when disabled", () => {
      runner = new MonitorRunner({ enabled: false });
      runner.start();

      const status = runner.getStatus();
      expect(status.running).toBe(false);
    });

    it("should warn when starting already running runner", () => {
      runner = new MonitorRunner({ runOnStart: false });
      runner.start();
      runner.start(); // Should not throw

      const status = runner.getStatus();
      expect(status.running).toBe(true);
    });
  });

  describe("runScan", () => {
    it("should run registered modules", async () => {
      runner = new MonitorRunner({ runOnStart: false });

      const findings: ScanFinding[] = [
        {
          type: "test",
          severity: "warn",
          message: "Test finding",
        },
      ];

      const module: ScanModule = {
        name: "test-module",
        scan: vi.fn().mockResolvedValue(findings),
      };

      runner.registerModule(module);

      const result = await runner.runScan();

      expect(module.scan).toHaveBeenCalled();
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].message).toBe("Test finding");
      expect(result.errors).toHaveLength(0);
    });

    it("should handle module errors gracefully", async () => {
      runner = new MonitorRunner({ runOnStart: false });

      const errorModule: ScanModule = {
        name: "error-module",
        scan: vi.fn().mockRejectedValue(new Error("Module crashed")),
      };

      const successModule: ScanModule = {
        name: "success-module",
        scan: vi
          .fn()
          .mockResolvedValue([{ type: "test", severity: "info" as const, message: "Success" }]),
      };

      runner.registerModule(errorModule);
      runner.registerModule(successModule);

      const result = await runner.runScan();

      // Both modules should have been called
      expect(errorModule.scan).toHaveBeenCalled();
      expect(successModule.scan).toHaveBeenCalled();

      // Should have error from failed module
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("error-module");

      // Should have finding from success module
      expect(result.findings).toHaveLength(1);
    });

    it("should skip when scan already in progress", async () => {
      runner = new MonitorRunner({ runOnStart: false });

      let resolveFirst: () => void;
      const firstScanPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

      const slowModule: ScanModule = {
        name: "slow-module",
        scan: async () => {
          await firstScanPromise;
          return [];
        },
      };

      runner.registerModule(slowModule);

      // Start first scan
      const firstScan = runner.runScan();

      // Try to start second scan while first is running
      const secondScan = await runner.runScan();

      expect(secondScan.errors).toContain("Scan already in progress");

      // Complete first scan
      resolveFirst!();
      await firstScan;
    });

    it("should update status after scan", async () => {
      runner = new MonitorRunner({ runOnStart: false });

      const module: ScanModule = {
        name: "test-module",
        scan: async () => [
          { type: "test", severity: "warn" as const, message: "Finding 1" },
          { type: "test", severity: "warn" as const, message: "Finding 2" },
        ],
      };

      runner.registerModule(module);

      await runner.runScan();

      const status = runner.getStatus();
      expect(status.lastScanAt).not.toBeNull();
      expect(status.lastScanDurationMs).not.toBeNull();
      expect(status.lastScanFindings).toBe(2);
      expect(status.scanCount).toBe(1);
    });

    it("should increment error count on errors", async () => {
      runner = new MonitorRunner({ runOnStart: false });

      const errorModule: ScanModule = {
        name: "error-module",
        scan: vi.fn().mockRejectedValue(new Error("Boom")),
      };

      runner.registerModule(errorModule);

      await runner.runScan();

      const status = runner.getStatus();
      expect(status.errorCount).toBe(1);
    });
  });

  describe("runDeepScan", () => {
    it("should run both regular and deep modules", async () => {
      runner = new MonitorRunner({ runOnStart: false });

      const regularModule: ScanModule = {
        name: "regular",
        scan: vi.fn().mockResolvedValue([]),
      };

      const deepModule: ScanModule = {
        name: "deep",
        scan: vi.fn().mockResolvedValue([]),
      };

      runner.registerModule(regularModule);
      runner.registerDeepModule(deepModule);

      await runner.runDeepScan();

      expect(regularModule.scan).toHaveBeenCalled();
      expect(deepModule.scan).toHaveBeenCalled();
    });

    it("should update lastDeepAuditAt", async () => {
      runner = new MonitorRunner({ runOnStart: false });

      expect(runner.getLastDeepAuditAt()).toBeNull();

      await runner.runDeepScan();

      expect(runner.getLastDeepAuditAt()).not.toBeNull();
    });
  });

  describe("scheduled scans", () => {
    it("should run scan after startup delay when runOnStart is true", async () => {
      runner = new MonitorRunner({
        runOnStart: true,
        startupDelayMs: 5000,
      });

      const module: ScanModule = {
        name: "test",
        scan: vi.fn().mockResolvedValue([]),
      };
      runner.registerModule(module);

      runner.start();

      // Not yet called
      expect(module.scan).not.toHaveBeenCalled();

      // Advance past startup delay
      await vi.advanceTimersByTimeAsync(5100);

      expect(module.scan).toHaveBeenCalledTimes(1);
    });

    it("should run periodic scans", async () => {
      runner = new MonitorRunner({
        runOnStart: false,
        every: "1m",
      });

      const module: ScanModule = {
        name: "test",
        scan: vi.fn().mockResolvedValue([]),
      };
      runner.registerModule(module);

      runner.start();

      // Advance 3 minutes
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);

      // Should have run 3 times
      expect(module.scan).toHaveBeenCalledTimes(3);
    });
  });

  describe("isCurrentlyScanning", () => {
    it("should return true during scan", async () => {
      runner = new MonitorRunner({ runOnStart: false });

      let resolveModule: () => void;
      const modulePromise = new Promise<void>((resolve) => {
        resolveModule = resolve;
      });

      const slowModule: ScanModule = {
        name: "slow",
        scan: async () => {
          await modulePromise;
          return [];
        },
      };

      runner.registerModule(slowModule);

      const scanPromise = runner.runScan();

      expect(runner.isCurrentlyScanning()).toBe(true);

      resolveModule!();
      await scanPromise;

      expect(runner.isCurrentlyScanning()).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("should return current status", () => {
      runner = new MonitorRunner({ enabled: true });

      const status = runner.getStatus();

      expect(status).toEqual({
        running: false,
        enabled: true,
        lastScanAt: null,
        lastScanDurationMs: null,
        lastScanFindings: 0,
        nextScanAt: null,
        scanCount: 0,
        errorCount: 0,
      });
    });
  });
});
