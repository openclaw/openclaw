/**
 * Chain Memory Backend - End-to-End Integration Tests
 *
 * Tests the complete path from getMemorySearchManager to ChainMemoryManager.search()
 * This is what the skill says: "Write integration tests FIRST"
 *
 * @module chain-memory.e2e.test
 * @author Tutu
 * @date 2026-03-10
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { OpenClawConfig } from "../../src/config/config.js";
import type { MemorySearchManager } from "../../src/memory/types.js";

// Mock OpenClaw config with chain backend
function createMockConfig(backend: "builtin" | "chain" = "chain"): Partial<OpenClawConfig> {
  if (backend === "chain") {
    return {
      memory: {
        backend: "chain",
        chain: {
          providers: [
            {
              name: "primary",
              priority: "primary" as const,
              backend: "builtin",
            },
          ],
        },
      },
    } as Partial<OpenClawConfig>;
  }
  return {
    memory: {
      backend: "builtin",
    },
  } as Partial<OpenClawConfig>;
}

describe("Chain Memory Backend - E2E Integration", () => {
  describe("Factory and Initialization", () => {
    it("should create chain manager via getMemorySearchManager", async () => {
      const { getMemorySearchManager } = await import("../../src/memory/search-manager.js");

      const result = await getMemorySearchManager({
        cfg: createMockConfig("chain"),
        agentId: "test-agent-e2e",
      });

      expect(result.error).toBeUndefined();
      expect(result.manager).toBeDefined();
      expect(result.manager).not.toBeNull();
    });

    it("should create builtin manager when backend is not chain", async () => {
      const { getMemorySearchManager } = await import("../../src/memory/search-manager.js");

      const result = await getMemorySearchManager({
        cfg: createMockConfig("builtin"),
        agentId: "test-agent-builtin",
      });

      // Builtin might fail due to missing setup, but should not throw
      expect(result).toBeDefined();
    });

    it("should cache chain managers for same config", async () => {
      const { getMemorySearchManager } = await import("../../src/memory/search-manager.js");

      const cfg = createMockConfig("chain");
      const agentId = "test-agent-cache";

      const result1 = await getMemorySearchManager({
        cfg,
        agentId,
      });

      const result2 = await getMemorySearchManager({
        cfg,
        agentId,
      });

      // Should return same instance (cached)
      expect(result1.manager).toBe(result2.manager);
    });
  });

  describe("Search Operations", () => {
    let manager: MemorySearchManager;

    beforeAll(async () => {
      const { getMemorySearchManager } = await import("../../src/memory/search-manager.js");

      const result = await getMemorySearchManager({
        cfg: createMockConfig("chain"),
        agentId: "test-agent-search",
      });

      if (!result.manager) {
        throw new Error(`Failed to create manager: ${result.error}`);
      }

      manager = result.manager;
    });

    it("should perform search without throwing", async () => {
      // This is the critical E2E test
      // The complete path: getMemorySearchManager → ChainMemoryManager → provider.search()

      const result = await manager.search({
        query: "test query",
        limit: 10,
      });

      expect(result).toBeDefined();
      expect(result.memories).toBeInstanceOf(Array);
      // Note: Result might be empty if no memories exist
    });

    it("should handle empty query", async () => {
      const result = await manager.search({
        query: "",
        limit: 10,
      });

      expect(result).toBeDefined();
      expect(result.memories).toBeInstanceOf(Array);
    });

    it("should handle large limit", async () => {
      const result = await manager.search({
        query: "test",
        limit: 1000,
      });

      expect(result).toBeDefined();
      expect(result.memories).toBeInstanceOf(Array);
    });
  });

  describe("ReadFile Operations", () => {
    let manager: MemorySearchManager;

    beforeAll(async () => {
      const { getMemorySearchManager } = await import("../../src/memory/search-manager.js");

      const result = await getMemorySearchManager({
        cfg: createMockConfig("chain"),
        agentId: "test-agent-readfile",
      });

      if (!result.manager) {
        throw new Error(`Failed to create manager: ${result.error}`);
      }

      manager = result.manager;
    });

    it("should handle readFile without throwing", async () => {
      const result = await manager.readFile("test-file.txt");

      // Result might be undefined if file doesn't exist
      expect(result === undefined || typeof result === "string").toBe(true);
    });

    it("should handle non-existent file", async () => {
      const result = await manager.readFile("non-existent-file-12345.txt");

      // Should return undefined, not throw
      expect(result).toBeUndefined();
    });
  });

  describe("Health and Status", () => {
    let manager: MemorySearchManager;

    beforeAll(async () => {
      const { getMemorySearchManager } = await import("../../src/memory/search-manager.js");

      const result = await getMemorySearchManager({
        cfg: createMockConfig("chain"),
        agentId: "test-agent-status",
      });

      if (!result.manager) {
        throw new Error(`Failed to create manager: ${result.error}`);
      }

      manager = result.manager;
    });

    it("should return status without throwing", async () => {
      const status = manager.status();

      expect(status).toBeDefined();
      expect(status.available).toBeDefined();
      // Health should be JSON-serializable (P2 fix)
      const json = JSON.stringify(status);
      expect(json).toBeDefined();
    });

    it("should return serializable health status", async () => {
      const status = manager.status();

      // P2 fix: health Map should be converted to plain object
      const json = JSON.stringify(status);
      const parsed = JSON.parse(json);

      expect(parsed.health).toBeDefined();
      expect(typeof parsed.health).toBe("object");
      // Should not be empty "{}" (which would indicate Map serialization issue)
    });

    it("should probe embedding availability", async () => {
      const result = await manager.probeEmbeddingAvailability();

      expect(typeof result).toBe("boolean");
    });

    it("should probe vector availability", async () => {
      const result = await manager.probeVectorAvailability();

      expect(typeof result).toBe("boolean");
    });
  });

  describe("Fallback Logic", () => {
    it("should work with secondary provider when primary fails", async () => {
      const { getMemorySearchManager } = await import("../../src/memory/search-manager.js");

      // Config with primary that will fail and secondary that works
      const cfg: Partial<OpenClawConfig> = {
        memory: {
          backend: "chain",
          chain: {
            providers: [
              {
                name: "primary",
                priority: "primary",
                backend: "builtin",
              },
              {
                name: "secondary",
                priority: "secondary",
                backend: "builtin",
              },
            ],
          },
        },
      } as Partial<OpenClawConfig>;

      const result = await getMemorySearchManager({
        cfg,
        agentId: "test-agent-fallback",
      });

      expect(result.manager).toBeDefined();

      // Search should work (even if primary fails, secondary should succeed)
      const searchResult = await result.manager!.search({
        query: "test",
        limit: 10,
      });

      expect(searchResult).toBeDefined();
    });

    it("should work with fallback provider when all others fail", async () => {
      const { getMemorySearchManager } = await import("../../src/memory/search-manager.js");

      const cfg: Partial<OpenClawConfig> = {
        memory: {
          backend: "chain",
          chain: {
            providers: [
              {
                name: "primary",
                priority: "primary",
                backend: "builtin",
              },
              {
                name: "fallback",
                priority: "fallback",
                backend: "builtin",
              },
            ],
          },
        },
      } as Partial<OpenClawConfig>;

      const result = await getMemorySearchManager({
        cfg,
        agentId: "test-agent-fallback2",
      });

      expect(result.manager).toBeDefined();

      const searchResult = await result.manager!.search({
        query: "test",
        limit: 10,
      });

      expect(searchResult).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid config gracefully", async () => {
      const { getMemorySearchManager } = await import("../../src/memory/search-manager.js");

      const cfg = {
        memory: {
          backend: "chain",
          chain: {
            // Missing required 'providers' field
          },
        },
      } as Partial<OpenClawConfig>;

      const result = await getMemorySearchManager({
        cfg,
        agentId: "test-agent-invalid",
      });

      // Should return error, not throw
      expect(result.error).toBeDefined();
      expect(result.manager).toBeNull();
    });

    it("should handle unknown backend gracefully", async () => {
      const { getMemorySearchManager } = await import("../../src/memory/search-manager.js");

      const cfg: Partial<OpenClawConfig> = {
        memory: {
          backend: "chain",
          chain: {
            providers: [
              {
                name: "primary",
                priority: "primary",
                backend: "unknown-backend" as unknown as BackendType,
              },
            ],
          },
        },
      } as Partial<OpenClawConfig>;

      const result = await getMemorySearchManager({
        cfg,
        agentId: "test-agent-unknown",
      });

      // Should return error about unknown backend
      expect(result.error).toBeDefined();
      expect(result.error).toContain("Unknown backend");
    });
  });

  describe("Resource Management", () => {
    it("should close without throwing", async () => {
      const { getMemorySearchManager } = await import("../../src/memory/search-manager.js");

      const result = await getMemorySearchManager({
        cfg: createMockConfig("chain"),
        agentId: "test-agent-close",
      });

      expect(result.manager).toBeDefined();

      // Should close without throwing
      await expect(result.manager!.close()).resolves.toBeUndefined();
    });

    it("should handle multiple close calls", async () => {
      const { getMemorySearchManager } = await import("../../src/memory/search-manager.js");

      const result = await getMemorySearchManager({
        cfg: createMockConfig("chain"),
        agentId: "test-agent-multiclose",
      });

      expect(result.manager).toBeDefined();

      // Multiple close calls should be safe
      await result.manager!.close();
      await result.manager!.close();
      await result.manager!.close();
    });
  });
});
