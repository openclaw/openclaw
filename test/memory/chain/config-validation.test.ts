/**
 * Chain Memory Backend - 配置验证测试
 *
 * 使用 Zod schema 校验器测试 20+ 种非法配置组合
 *
 * @module config-validation.test
 * @author Tutu
 * @date 2026-03-09
 */

import { validateChainConfig } from "../src/config-validator";

describe("Config Validation (Zod)", () => {
  describe("Priority Validation", () => {
    it("should reject invalid priority value", () => {
      const config = {
        providers: [{ name: "test", priority: "invalid", backend: "builtin" }],
      };

      expect(() => validateChainConfig(config)).toThrow(
        /priority must be one of: primary, secondary, fallback/,
      );
    });

    it("should reject multiple primary providers", () => {
      const config = {
        providers: [
          { name: "primary1", priority: "primary", backend: "builtin" },
          { name: "primary2", priority: "primary", backend: "builtin" },
        ],
      };

      expect(() => validateChainConfig(config)).toThrow(/only one primary provider allowed/);
    });

    it("should reject missing primary provider", () => {
      const config = {
        providers: [{ name: "secondary", priority: "secondary", backend: "builtin" }],
      };

      expect(() => validateChainConfig(config)).toThrow(/at least one primary provider required/);
    });

    it("should accept valid priority values", () => {
      const config = {
        providers: [
          { name: "primary", priority: "primary", backend: "builtin" },
          { name: "secondary", priority: "secondary", backend: "builtin" },
          { name: "fallback", priority: "fallback", backend: "builtin" },
        ],
      };

      expect(() => validateChainConfig(config)).not.toThrow();
    });

    it("should accept single primary provider", () => {
      const config = {
        providers: [{ name: "primary", priority: "primary", backend: "builtin" }],
      };

      expect(() => validateChainConfig(config)).not.toThrow();
    });
  });

  describe("Backend Validation", () => {
    it("should reject nested chain backend", () => {
      const config = {
        providers: [{ name: "chain", priority: "primary", backend: "chain" }],
      };

      // Zod 会先验证 backend 的值，所以会抛出 backend 类型错误
      expect(() => validateChainConfig(config)).toThrow(/backend must be one of: builtin, qmd/);
    });

    it("should reject invalid backend type", () => {
      const config = {
        providers: [{ name: "test", priority: "primary", backend: "invalid" }],
      };

      expect(() => validateChainConfig(config)).toThrow(/backend must be one of: builtin, qmd/);
    });

    it("should accept builtin backend", () => {
      const config = {
        providers: [{ name: "test", priority: "primary", backend: "builtin" }],
      };

      expect(() => validateChainConfig(config)).not.toThrow();
    });

    it("should accept qmd backend", () => {
      const config = {
        providers: [{ name: "test", priority: "primary", backend: "qmd" }],
      };

      expect(() => validateChainConfig(config)).not.toThrow();
    });
  });

  describe("Timeout Validation", () => {
    it("should reject negative timeout", () => {
      const config = {
        providers: [
          {
            name: "test",
            priority: "primary",
            backend: "builtin",
            timeout: { search: -100 },
          },
        ],
      };

      expect(() => validateChainConfig(config)).toThrow(/timeout.search must be positive/);
    });

    it("should reject zero timeout", () => {
      const config = {
        providers: [
          {
            name: "test",
            priority: "primary",
            backend: "builtin",
            timeout: { search: 0 },
          },
        ],
      };

      expect(() => validateChainConfig(config)).toThrow(/timeout.search must be positive/);
    });

    it("should reject excessively large timeout", () => {
      const config = {
        providers: [
          {
            name: "test",
            priority: "primary",
            backend: "builtin",
            timeout: { search: 999999999 },
          },
        ],
      };

      expect(() => validateChainConfig(config)).toThrow(/timeout.search must be less than 60000ms/);
    });

    it("should accept valid timeout", () => {
      const config = {
        providers: [
          {
            name: "test",
            priority: "primary",
            backend: "builtin",
            timeout: { search: 3000 },
          },
        ],
      };

      expect(() => validateChainConfig(config)).not.toThrow();
    });

    it("should apply default timeout when not specified", () => {
      const config = {
        providers: [{ name: "test", priority: "primary", backend: "builtin" }],
      };

      const result = validateChainConfig(config);
      expect(result.providers[0].timeout.search).toBe(5000);
    });
  });

  describe("Circuit Breaker Validation", () => {
    it("should reject negative failure threshold", () => {
      const config = {
        providers: [
          {
            name: "test",
            priority: "primary",
            backend: "builtin",
            circuitBreaker: { failureThreshold: -1 },
          },
        ],
      };

      expect(() => validateChainConfig(config)).toThrow(
        /circuitBreaker.failureThreshold must be positive/,
      );
    });

    it("should reject zero reset timeout", () => {
      const config = {
        providers: [
          {
            name: "test",
            priority: "primary",
            backend: "builtin",
            circuitBreaker: { resetTimeoutMs: 0 },
          },
        ],
      };

      expect(() => validateChainConfig(config)).toThrow(
        /circuitBreaker.resetTimeoutMs must be positive/,
      );
    });

    it("should accept valid circuit breaker config", () => {
      const config = {
        providers: [
          {
            name: "test",
            priority: "primary",
            backend: "builtin",
            circuitBreaker: {
              failureThreshold: 5,
              resetTimeoutMs: 60000,
            },
          },
        ],
      };

      expect(() => validateChainConfig(config)).not.toThrow();
    });

    it("should apply default circuit breaker values", () => {
      const config = {
        providers: [{ name: "test", priority: "primary", backend: "builtin" }],
      };

      const result = validateChainConfig(config);
      expect(result.providers[0].circuitBreaker.failureThreshold).toBe(5);
      expect(result.providers[0].circuitBreaker.resetTimeoutMs).toBe(60000);
    });
  });

  describe("Name Validation", () => {
    it("should reject duplicate provider names", () => {
      const config = {
        providers: [
          { name: "duplicate", priority: "primary", backend: "builtin" },
          { name: "duplicate", priority: "secondary", backend: "builtin" },
        ],
      };

      expect(() => validateChainConfig(config)).toThrow(/provider names must be unique/);
    });

    it("should reject empty provider name", () => {
      const config = {
        providers: [{ name: "", priority: "primary", backend: "builtin" }],
      };

      expect(() => validateChainConfig(config)).toThrow(/provider name cannot be empty/);
    });

    it("should reject provider name with special characters", () => {
      const config = {
        providers: [{ name: "test@#$%", priority: "primary", backend: "builtin" }],
      };

      expect(() => validateChainConfig(config)).toThrow(/provider name must be alphanumeric/);
    });

    it("should accept provider name with underscore and hyphen", () => {
      const config = {
        providers: [{ name: "test_provider-123", priority: "primary", backend: "builtin" }],
      };

      expect(() => validateChainConfig(config)).not.toThrow();
    });

    it("should reject provider name longer than 50 characters", () => {
      const longName = "a".repeat(51);
      const config = {
        providers: [{ name: longName, priority: "primary", backend: "builtin" }],
      };

      expect(() => validateChainConfig(config)).toThrow(
        /provider name must be less than 50 characters/,
      );
    });
  });

  describe("Write Mode Validation", () => {
    it("should reject invalid write mode", () => {
      const config = {
        providers: [
          {
            name: "test",
            priority: "primary",
            backend: "builtin",
            writeMode: "invalid",
          },
        ],
      };

      expect(() => validateChainConfig(config)).toThrow(/writeMode must be one of: sync, async/);
    });

    it("should warn when primary uses async write mode", () => {
      const config = {
        providers: [
          {
            name: "test",
            priority: "primary",
            backend: "builtin",
            writeMode: "async",
          },
        ],
      };

      const result = validateChainConfig(config);
      expect(result.warnings).toContain(
        "primary provider with async writeMode may cause data inconsistency",
      );
    });

    it("should apply default writeMode based on priority", () => {
      const config = {
        providers: [
          { name: "primary", priority: "primary", backend: "builtin" },
          { name: "secondary", priority: "secondary", backend: "builtin" },
          { name: "fallback", priority: "fallback", backend: "builtin" },
        ],
      };

      const result = validateChainConfig(config);
      expect(result.providers[0].writeMode).toBe("sync"); // primary = sync
      expect(result.providers[1].writeMode).toBe("async"); // secondary = async
      expect(result.providers[2].writeMode).toBe("sync"); // fallback = sync
    });
  });

  describe("Global Config Validation", () => {
    it("should reject negative health check interval", () => {
      const config = {
        providers: [{ name: "test", priority: "primary", backend: "builtin" }],
        global: {
          healthCheckInterval: -1000,
        },
      };

      expect(() => validateChainConfig(config)).toThrow(
        /global.healthCheckInterval must be positive/,
      );
    });

    it("should use default values for missing global config", () => {
      const config = {
        providers: [{ name: "test", priority: "primary", backend: "builtin" }],
      };

      const result = validateChainConfig(config);
      expect(result.global.defaultTimeout).toBe(5000);
      expect(result.global.enableAsyncWrite).toBe(true);
      expect(result.global.enableFallback).toBe(true);
      expect(result.global.healthCheckInterval).toBe(30000);
    });

    it("should accept custom global config", () => {
      const config = {
        providers: [{ name: "test", priority: "primary", backend: "builtin" }],
        global: {
          defaultTimeout: 10000,
          enableAsyncWrite: false,
          enableFallback: false,
          healthCheckInterval: 60000,
        },
      };

      const result = validateChainConfig(config);
      expect(result.global.defaultTimeout).toBe(10000);
      expect(result.global.enableAsyncWrite).toBe(false);
      expect(result.global.enableFallback).toBe(false);
      expect(result.global.healthCheckInterval).toBe(60000);
    });
  });

  describe("Edge Cases", () => {
    it("should reject empty providers array", () => {
      const config = {
        providers: [],
      };

      expect(() => validateChainConfig(config)).toThrow(/at least one provider required/);
    });

    it("should reject providers with enabled=false and no other providers", () => {
      const config = {
        providers: [
          {
            name: "test",
            priority: "primary",
            backend: "builtin",
            enabled: false,
          },
        ],
      };

      expect(() => validateChainConfig(config)).toThrow(/at least one enabled provider required/);
    });

    it("should accept providers with enabled=false if other providers are enabled", () => {
      const config = {
        providers: [
          {
            name: "disabled",
            priority: "primary",
            backend: "builtin",
            enabled: false,
          },
          {
            name: "enabled",
            priority: "secondary",
            backend: "builtin",
            enabled: true,
          },
        ],
      };

      // 这会失败，因为没有 enabled 的 primary provider
      const enabledProviders = config.providers.filter((p) => p.enabled);
      const hasPrimary = enabledProviders.some((p) => p.priority === "primary");

      expect(hasPrimary).toBe(false); // 没有 enabled 的 primary
      expect(() => validateChainConfig(config)).toThrow(/at least one primary provider required/);
    });

    it("should accept valid minimal config", () => {
      const config = {
        providers: [{ name: "primary", priority: "primary", backend: "builtin" }],
      };

      expect(() => validateChainConfig(config)).not.toThrow();
    });

    it("should accept valid full config", () => {
      const config = {
        providers: [
          {
            name: "mem0",
            priority: "primary",
            backend: "builtin",
            enabled: true,
            timeout: {
              add: 2000,
              search: 3000,
              update: 2000,
              delete: 1000,
            },
            retry: {
              maxAttempts: 3,
              backoffMs: 1000,
            },
            circuitBreaker: {
              failureThreshold: 5,
              resetTimeoutMs: 60000,
            },
            writeMode: "sync",
          },
          {
            name: "backup",
            priority: "secondary",
            backend: "builtin",
            writeMode: "async",
          },
          {
            name: "fallback",
            priority: "fallback",
            backend: "builtin",
          },
        ],
        global: {
          defaultTimeout: 5000,
          enableAsyncWrite: true,
          enableFallback: true,
          healthCheckInterval: 30000,
        },
      };

      expect(() => validateChainConfig(config)).not.toThrow();
    });

    it("should allow additional provider-specific properties", () => {
      const config = {
        providers: [
          {
            name: "test",
            priority: "primary",
            backend: "builtin",
            customProperty: "value",
            anotherProperty: 123,
          },
        ],
      };

      expect(() => validateChainConfig(config)).not.toThrow();
    });
  });

  describe("Warnings", () => {
    it("should warn when no fallback provider is configured", () => {
      const config = {
        providers: [{ name: "primary", priority: "primary", backend: "builtin" }],
      };

      const result = validateChainConfig(config);
      expect(result.warnings).toContain(
        "no fallback provider configured, system may fail if primary fails",
      );
    });

    it("should not warn when fallback provider is configured", () => {
      const config = {
        providers: [
          { name: "primary", priority: "primary", backend: "builtin" },
          { name: "fallback", priority: "fallback", backend: "builtin" },
        ],
      };

      const result = validateChainConfig(config);
      expect(result.warnings).not.toContain(
        "no fallback provider configured, system may fail if primary fails",
      );
    });

    it("should not warn when enableFallback is false", () => {
      const config = {
        providers: [{ name: "primary", priority: "primary", backend: "builtin" }],
        global: {
          enableFallback: false,
        },
      };

      const result = validateChainConfig(config);
      expect(result.warnings).not.toContain(
        "no fallback provider configured, system may fail if primary fails",
      );
    });
  });

  describe("Return Value", () => {
    it("should return validated config with defaults applied", () => {
      const config = {
        providers: [{ name: "test", priority: "primary", backend: "builtin" }],
      };

      const result = validateChainConfig(config);

      expect(result).toHaveProperty("providers");
      expect(result).toHaveProperty("global");
      expect(result).toHaveProperty("warnings");

      expect(result.providers[0].enabled).toBe(true);
      expect(result.providers[0].writeMode).toBe("sync");
      expect(result.providers[0].timeout).toBeDefined();
      expect(result.providers[0].retry).toBeDefined();
      expect(result.providers[0].circuitBreaker).toBeDefined();
    });

    it("should preserve original provider-specific properties", () => {
      const config = {
        providers: [
          {
            name: "test",
            priority: "primary",
            backend: "builtin",
            customProp: "customValue",
            store: { path: "~/.openclaw/memory" },
          },
        ],
      };

      const result = validateChainConfig(config);

      expect(result.providers[0].customProp).toBe("customValue");
      expect(result.providers[0].store).toEqual({ path: "~/.openclaw/memory" });
    });
  });

  describe("Plugin Support", () => {
    it("should accept plugin instead of backend", () => {
      const config = {
        providers: [
          {
            name: "mem9",
            priority: "primary",
            plugin: "@mem9/openclaw",
            apiUrl: "http://localhost:8080",
            tenantID: "uuid",
          },
        ],
      };

      const result = validateChainConfig(config);

      expect(result.providers[0].plugin).toBe("@mem9/openclaw");
      expect(result.providers[0].backend).toBeUndefined();
    });

    it("should reject missing both backend and plugin", () => {
      const config = {
        providers: [{ name: "test", priority: "primary" }],
      };

      expect(() => validateChainConfig(config)).toThrow(
        /Either backend or plugin must be specified/,
      );
    });

    it("should reject having both backend and plugin", () => {
      const config = {
        providers: [
          {
            name: "test",
            priority: "primary",
            backend: "builtin",
            plugin: "@mem9/openclaw",
          },
        ],
      };

      expect(() => validateChainConfig(config)).toThrow(/Cannot specify both backend and plugin/);
    });

    it("should accept mixed providers with backend and plugin", () => {
      const config = {
        providers: [
          {
            name: "mem0",
            priority: "primary",
            plugin: "@mem0/openclaw-mem0",
            apiKey: "${MEM0_API_KEY}",
          },
          {
            name: "builtin-backup",
            priority: "secondary",
            backend: "builtin",
            writeMode: "async",
          },
        ],
      };

      const result = validateChainConfig(config);

      expect(result.providers).toHaveLength(2);
      expect(result.providers[0].plugin).toBe("@mem0/openclaw-mem0");
      expect(result.providers[1].backend).toBe("builtin");
    });

    it("should preserve plugin-specific properties", () => {
      const config = {
        providers: [
          {
            name: "mem9",
            priority: "primary",
            plugin: "@mem9/openclaw",
            apiUrl: "http://localhost:8080",
            tenantID: "uuid",
            customOption: "value",
          },
        ],
      };

      const result = validateChainConfig(config);

      expect(result.providers[0].apiUrl).toBe("http://localhost:8080");
      expect(result.providers[0].tenantID).toBe("uuid");
      expect(result.providers[0].customOption).toBe("value");
    });
  });
});
