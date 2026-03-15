/**
 * Chain Memory Backend - Integration Tests
 *
 * Core functionality integration tests
 *
 * @module integration.test
 * @author Tutu
 * @date 2026-03-09
 */

import { describe, it, expect } from "vitest";
import { validateChainConfig } from "../src/config-validator.js";
import { CircuitBreaker } from "../src/memory/chain/circuit-breaker.js";

describe("Integration Tests", () => {
  describe("Circuit Breaker", () => {
    it("should start in CLOSED state", () => {
      const cb = new CircuitBreaker();
      expect(cb.getState()).toBe("CLOSED");
      expect(cb.isOpen()).toBe(false);
    });

    it("should open after threshold failures", () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });

      // Record 3 failures
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();

      expect(cb.getState()).toBe("OPEN");
      expect(cb.isOpen()).toBe(true);
    });

    it("should reset to CLOSED after timeout", async () => {
      const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 100 });

      // Trigger circuit breaker
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe("OPEN");

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should enter HALF-OPEN
      expect(cb.isOpen()).toBe(false);
      expect(cb.getState()).toBe("HALF-OPEN");

      // Record success, should return to CLOSED
      cb.recordSuccess();
      expect(cb.getState()).toBe("CLOSED");
    });

    it("should reset on success", () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });

      // Record some failures
      cb.recordFailure();
      cb.recordFailure();

      // Record success
      cb.recordSuccess();

      expect(cb.getState()).toBe("CLOSED");
      expect(cb.getFailureCount()).toBe(0);
    });
  });

  describe("Config Validation", () => {
    it("should validate and apply defaults", () => {
      const config = {
        providers: [{ name: "test", priority: "primary" as const, backend: "builtin" as const }],
      };

      const result = validateChainConfig(config);

      expect(result.global.defaultTimeout).toBe(5000);
      expect(result.global.enableFallback).toBe(true);
      expect(result.global.healthCheckInterval).toBe(30000);

      expect(result.providers[0].enabled).toBe(true);
    });

    it("should reject invalid config", () => {
      const config = {
        providers: [
          {
            name: "test",
            priority: "invalid" as unknown as "primary",
            backend: "builtin" as const,
          },
        ],
      };

      expect(() => validateChainConfig(config)).toThrow();
    });
  });

  describe("End-to-End Flow", () => {
    it("should handle complete flow with circuit breaker", async () => {
      // 1. Validate configuration
      const config = {
        providers: [
          {
            name: "primary",
            priority: "primary" as const,
            backend: "builtin" as const,
            circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 1000 },
          },
          {
            name: "backup",
            priority: "secondary" as const,
            backend: "builtin" as const,
          },
        ],
      };

      const validated = validateChainConfig(config);
      expect(validated.providers).toHaveLength(2);

      // 2. Create circuit breaker
      const cb = new CircuitBreaker(validated.providers[0].circuitBreaker);
      expect(cb.getState()).toBe("CLOSED");

      // 3. Simulate failures and circuit breaker trigger
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();

      expect(cb.isOpen()).toBe(true);

      // 4. Wait for recovery
      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(cb.isOpen()).toBe(false);
      expect(cb.getState()).toBe("HALF-OPEN");

      // 5. Success should close the circuit
      cb.recordSuccess();
      expect(cb.getState()).toBe("CLOSED");
    });

    it("should validate multi-provider configuration", () => {
      const config = {
        providers: [
          {
            name: "primary",
            priority: "primary" as const,
            backend: "builtin" as const,
            timeout: { search: 3000 },
          },
          {
            name: "fallback",
            priority: "fallback" as const,
            backend: "qmd" as const,
            timeout: { search: 10000 },
          },
        ],
      };

      const result = validateChainConfig(config);

      expect(result.providers).toHaveLength(2);
      expect(result.providers[0].timeout.search).toBe(3000);
      expect(result.providers[1].timeout.search).toBe(10000);
      expect(result.global.enableFallback).toBe(true);
    });
  });
});
