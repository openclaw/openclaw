/* eslint-disable typescript-eslint/unbound-method */
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { IntrusionDetector } from "./intrusion-detector.js";
import { SecurityActions, AttackPatterns, type SecurityEvent } from "./events/schema.js";
import { ipManager } from "./ip-manager.js";
import { securityEventAggregator } from "./events/aggregator.js";

vi.mock("./ip-manager.js", () => ({
  ipManager: {
    blockIp: vi.fn(),
  },
}));

describe("IntrusionDetector", () => {
  let detector: IntrusionDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    securityEventAggregator.clearAll(); // Clear event state between tests
    detector = new IntrusionDetector({
      enabled: true,
      patterns: {
        bruteForce: { threshold: 10, windowMs: 600_000 },
        ssrfBypass: { threshold: 3, windowMs: 300_000 },
        pathTraversal: { threshold: 5, windowMs: 300_000 },
        portScanning: { threshold: 20, windowMs: 10_000 },
      },
      anomalyDetection: {
        enabled: false,
        learningPeriodMs: 86_400_000,
        sensitivityScore: 0.95,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createTestEvent = (action: string): SecurityEvent => ({
    timestamp: new Date().toISOString(),
    eventId: `event-${Math.random()}`,
    severity: "warn",
    category: "authentication",
    ip: "192.168.1.100",
    action,
    resource: "test_resource",
    outcome: "deny",
    details: {},
  });

  describe("checkBruteForce", () => {
    it("should detect brute force after threshold", () => {
      const ip = "192.168.1.100";

      // Submit 9 failed auth attempts (below threshold)
      for (let i = 0; i < 9; i++) {
        const result = detector.checkBruteForce({
          ip,
          event: createTestEvent(SecurityActions.AUTH_FAILED),
        });
        expect(result.detected).toBe(false);
      }

      // 10th attempt should trigger detection
      const result = detector.checkBruteForce({
        ip,
        event: createTestEvent(SecurityActions.AUTH_FAILED),
      });

      expect(result.detected).toBe(true);
      expect(result.pattern).toBe(AttackPatterns.BRUTE_FORCE);
      expect(result.count).toBe(10);
      expect(result.threshold).toBe(10);
      expect(ipManager.blockIp).toHaveBeenCalledWith({
        ip,
        reason: AttackPatterns.BRUTE_FORCE,
        durationMs: 86_400_000,
        source: "auto",
      });
    });

    it("should track different IPs independently", () => {
      const ip1 = "192.168.1.1";
      const ip2 = "192.168.1.2";

      // IP1: 5 attempts
      for (let i = 0; i < 5; i++) {
        detector.checkBruteForce({
          ip: ip1,
          event: createTestEvent(SecurityActions.AUTH_FAILED),
        });
      }

      // IP2: 5 attempts
      for (let i = 0; i < 5; i++) {
        detector.checkBruteForce({
          ip: ip2,
          event: createTestEvent(SecurityActions.AUTH_FAILED),
        });
      }

      // Neither should trigger (both under threshold)
      const result1 = detector.checkBruteForce({
        ip: ip1,
        event: createTestEvent(SecurityActions.AUTH_FAILED),
      });
      const result2 = detector.checkBruteForce({
        ip: ip2,
        event: createTestEvent(SecurityActions.AUTH_FAILED),
      });

      expect(result1.detected).toBe(false);
      expect(result2.detected).toBe(false);
    });

    it("should not detect when disabled", () => {
      const disabledDetector = new IntrusionDetector({ enabled: false });
      const ip = "192.168.1.100";

      // Submit 20 attempts (well over threshold)
      for (let i = 0; i < 20; i++) {
        const result = disabledDetector.checkBruteForce({
          ip,
          event: createTestEvent(SecurityActions.AUTH_FAILED),
        });
        expect(result.detected).toBe(false);
      }

      expect(ipManager.blockIp).not.toHaveBeenCalled();
    });
  });

  describe("checkSsrfBypass", () => {
    it("should detect SSRF bypass after threshold", () => {
      const ip = "192.168.1.100";

      // Submit 2 SSRF attempts (below threshold)
      for (let i = 0; i < 2; i++) {
        const result = detector.checkSsrfBypass({
          ip,
          event: createTestEvent(SecurityActions.SSRF_BYPASS_ATTEMPT),
        });
        expect(result.detected).toBe(false);
      }

      // 3rd attempt should trigger detection
      const result = detector.checkSsrfBypass({
        ip,
        event: createTestEvent(SecurityActions.SSRF_BYPASS_ATTEMPT),
      });

      expect(result.detected).toBe(true);
      expect(result.pattern).toBe(AttackPatterns.SSRF_BYPASS);
      expect(result.count).toBe(3);
      expect(ipManager.blockIp).toHaveBeenCalledWith({
        ip,
        reason: AttackPatterns.SSRF_BYPASS,
        durationMs: 86_400_000,
        source: "auto",
      });
    });

    it("should handle lower threshold than brute force", () => {
      const ip = "192.168.1.100";

      // SSRF has lower threshold (3) than brute force (10)
      for (let i = 0; i < 3; i++) {
        detector.checkSsrfBypass({
          ip,
          event: createTestEvent(SecurityActions.SSRF_BYPASS_ATTEMPT),
        });
      }

      // Should detect with fewer attempts
      expect(ipManager.blockIp).toHaveBeenCalled();
    });
  });

  describe("checkPathTraversal", () => {
    it("should detect path traversal after threshold", () => {
      const ip = "192.168.1.100";

      // Submit 4 attempts (below threshold)
      for (let i = 0; i < 4; i++) {
        const result = detector.checkPathTraversal({
          ip,
          event: createTestEvent(SecurityActions.PATH_TRAVERSAL_ATTEMPT),
        });
        expect(result.detected).toBe(false);
      }

      // 5th attempt should trigger detection
      const result = detector.checkPathTraversal({
        ip,
        event: createTestEvent(SecurityActions.PATH_TRAVERSAL_ATTEMPT),
      });

      expect(result.detected).toBe(true);
      expect(result.pattern).toBe(AttackPatterns.PATH_TRAVERSAL);
      expect(result.count).toBe(5);
      expect(ipManager.blockIp).toHaveBeenCalledWith({
        ip,
        reason: AttackPatterns.PATH_TRAVERSAL,
        durationMs: 86_400_000,
        source: "auto",
      });
    });
  });

  describe("checkPortScanning", () => {
    it("should detect port scanning after threshold", () => {
      const ip = "192.168.1.100";

      // Submit 19 connection attempts (below threshold)
      for (let i = 0; i < 19; i++) {
        const result = detector.checkPortScanning({
          ip,
          event: createTestEvent(SecurityActions.CONNECTION_LIMIT_EXCEEDED),
        });
        expect(result.detected).toBe(false);
      }

      // 20th attempt should trigger detection
      const result = detector.checkPortScanning({
        ip,
        event: createTestEvent(SecurityActions.CONNECTION_LIMIT_EXCEEDED),
      });

      expect(result.detected).toBe(true);
      expect(result.pattern).toBe(AttackPatterns.PORT_SCANNING);
      expect(result.count).toBe(20);
      expect(ipManager.blockIp).toHaveBeenCalledWith({
        ip,
        reason: AttackPatterns.PORT_SCANNING,
        durationMs: 86_400_000,
        source: "auto",
      });
    });

    it("should handle rapid connection attempts", () => {
      const ip = "192.168.1.100";

      // Rapid-fire 25 connection attempts
      for (let i = 0; i < 25; i++) {
        detector.checkPortScanning({
          ip,
          event: createTestEvent(SecurityActions.CONNECTION_LIMIT_EXCEEDED),
        });
      }

      // Should auto-block
      expect(ipManager.blockIp).toHaveBeenCalled();
    });
  });

  describe("time window behavior", () => {
    it("should reset detection after time window", () => {
      vi.useFakeTimers();
      const ip = "192.168.1.100";

      // Submit 9 attempts
      for (let i = 0; i < 9; i++) {
        detector.checkBruteForce({
          ip,
          event: createTestEvent(SecurityActions.AUTH_FAILED),
        });
      }

      // Advance past window (10 minutes)
      vi.advanceTimersByTime(601_000);

      // Submit 9 more attempts (should not trigger, old attempts expired)
      for (let i = 0; i < 9; i++) {
        const result = detector.checkBruteForce({
          ip,
          event: createTestEvent(SecurityActions.AUTH_FAILED),
        });
        expect(result.detected).toBe(false);
      }

      vi.useRealTimers();
    });
  });

  describe("custom configuration", () => {
    it("should respect custom thresholds", () => {
      const customDetector = new IntrusionDetector({
        enabled: true,
        patterns: {
          bruteForce: { threshold: 3, windowMs: 60_000 },
          ssrfBypass: { threshold: 1, windowMs: 60_000 },
          pathTraversal: { threshold: 2, windowMs: 60_000 },
          portScanning: { threshold: 5, windowMs: 10_000 },
        },
        anomalyDetection: {
          enabled: false,
          learningPeriodMs: 86_400_000,
          sensitivityScore: 0.95,
        },
      });

      const ip = "192.168.1.100";

      // Should trigger with custom threshold (3)
      for (let i = 0; i < 3; i++) {
        customDetector.checkBruteForce({
          ip,
          event: createTestEvent(SecurityActions.AUTH_FAILED),
        });
      }

      expect(ipManager.blockIp).toHaveBeenCalled();
    });

    it("should respect custom time windows", () => {
      vi.useFakeTimers();
      vi.setSystemTime(0); // Start at time 0

      const customDetector = new IntrusionDetector({
        enabled: true,
        patterns: {
          bruteForce: { threshold: 5, windowMs: 10_000 }, // 10 seconds
          ssrfBypass: { threshold: 3, windowMs: 300_000 },
          pathTraversal: { threshold: 5, windowMs: 300_000 },
          portScanning: { threshold: 20, windowMs: 10_000 },
        },
        anomalyDetection: {
          enabled: false,
          learningPeriodMs: 86_400_000,
          sensitivityScore: 0.95,
        },
      });

      const ip = "192.168.1.100";

      // Submit 4 attempts
      for (let i = 0; i < 4; i++) {
        customDetector.checkBruteForce({
          ip,
          event: createTestEvent(SecurityActions.AUTH_FAILED),
        });
      }

      // Advance past short window
      vi.advanceTimersByTime(11_000);

      // Submit 4 more attempts (should not trigger, old attempts expired)
      for (let i = 0; i < 4; i++) {
        const result = customDetector.checkBruteForce({
          ip,
          event: createTestEvent(SecurityActions.AUTH_FAILED),
        });
        expect(result.detected).toBe(false);
      }

      vi.useRealTimers();
    });
  });

  describe("integration scenarios", () => {
    it("should detect multiple attack patterns from same IP", () => {
      const ip = "192.168.1.100";

      // Trigger brute force
      for (let i = 0; i < 10; i++) {
        detector.checkBruteForce({
          ip,
          event: createTestEvent(SecurityActions.AUTH_FAILED),
        });
      }

      // Trigger SSRF bypass
      for (let i = 0; i < 3; i++) {
        detector.checkSsrfBypass({
          ip,
          event: createTestEvent(SecurityActions.SSRF_BYPASS_ATTEMPT),
        });
      }

      // Should auto-block for both patterns
      expect(ipManager.blockIp).toHaveBeenCalledTimes(2);
      expect(ipManager.blockIp).toHaveBeenCalledWith(
        expect.objectContaining({ reason: AttackPatterns.BRUTE_FORCE }),
      );
      expect(ipManager.blockIp).toHaveBeenCalledWith(
        expect.objectContaining({ reason: AttackPatterns.SSRF_BYPASS }),
      );
    });

    it("should handle coordinated attack from multiple IPs", () => {
      // Simulate distributed brute force attack
      const ips = ["192.168.1.1", "192.168.1.2", "192.168.1.3"];

      ips.forEach((ip) => {
        for (let i = 0; i < 10; i++) {
          detector.checkBruteForce({
            ip,
            event: createTestEvent(SecurityActions.AUTH_FAILED),
          });
        }
      });

      // Should block all attacking IPs
      expect(ipManager.blockIp).toHaveBeenCalledTimes(3);
    });
  });
});
