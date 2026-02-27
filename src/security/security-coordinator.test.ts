/**
 * SecuritySubsystemCoordinator Tests (AR-1)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetAnomalyDetectors } from "./anomaly-detection.js";
import { resetMonitorRunner } from "./monitor-runner.js";
import {
  SecuritySubsystemCoordinator,
  getSecurityCoordinator,
  resetSecurityCoordinator,
} from "./security-coordinator.js";
import { resetSecurityEventsManager } from "./security-events.js";
import { resetSessionRiskMonitor } from "./session-monitoring.js";
import { resetToolMonitor } from "./tool-monitoring.js";

function resetAll(): void {
  resetMonitorRunner();
  resetSessionRiskMonitor();
  resetToolMonitor();
  resetAnomalyDetectors();
  resetSecurityEventsManager();
  resetSecurityCoordinator();
}

describe("SecuritySubsystemCoordinator", () => {
  beforeEach(() => {
    resetAll();
  });

  afterEach(() => {
    resetAll();
  });

  describe("start()", () => {
    it("initializes all subsystems without throwing", async () => {
      const coordinator = new SecuritySubsystemCoordinator({
        runner: { enabled: false }, // no polling in tests
      });
      await expect(coordinator.start()).resolves.not.toThrow();
      expect(coordinator.isStarted()).toBe(true);
      await coordinator.stop();
    });

    it("is idempotent — second start() call is a no-op", async () => {
      const coordinator = new SecuritySubsystemCoordinator({
        runner: { enabled: false },
      });
      await coordinator.start();
      await coordinator.start(); // should not throw or re-initialize
      expect(coordinator.isStarted()).toBe(true);
      await coordinator.stop();
    });
  });

  describe("stop()", () => {
    it("sets isStarted() to false", async () => {
      const coordinator = new SecuritySubsystemCoordinator({
        runner: { enabled: false },
      });
      await coordinator.start();
      expect(coordinator.isStarted()).toBe(true);
      await coordinator.stop();
      expect(coordinator.isStarted()).toBe(false);
    });

    it("stop() before start() is a no-op", async () => {
      const coordinator = new SecuritySubsystemCoordinator();
      await expect(coordinator.stop()).resolves.not.toThrow();
    });
  });

  describe("getSecurityCoordinator() singleton", () => {
    it("returns the same instance on repeated calls", () => {
      const a = getSecurityCoordinator();
      const b = getSecurityCoordinator();
      expect(a).toBe(b);
    });

    it("ignores config on second call (singleton already set)", () => {
      getSecurityCoordinator();
      // Second call with a different config should not throw and returns same instance.
      const c = getSecurityCoordinator({ runner: { enabled: false } });
      expect(c).toBe(getSecurityCoordinator());
    });

    it("resetSecurityCoordinator() allows a fresh instance to be created", () => {
      const first = getSecurityCoordinator();
      resetSecurityCoordinator();
      const second = getSecurityCoordinator();
      expect(first).not.toBe(second);
    });
  });

  describe("start → stop → start lifecycle", () => {
    it("can be restarted after stop", async () => {
      const coordinator = new SecuritySubsystemCoordinator({
        runner: { enabled: false },
      });

      await coordinator.start();
      await coordinator.stop();

      // After stop, singletons are reset — a fresh start should work.
      resetAll(); // clear singletons so start can re-init them
      await coordinator.start();
      expect(coordinator.isStarted()).toBe(true);
      await coordinator.stop();
    });
  });
});
