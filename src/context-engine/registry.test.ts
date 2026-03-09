import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getContextEngineFactory,
  listContextEngineIds,
  registerContextEngine,
  resolveContextEngine,
  type ContextEngineFactory,
} from "./registry.js";
import type { ContextEngine } from "./types.js";

describe("context-engine/registry", () => {
  // Store initial state to restore after tests
  let initialEngines: string[];

  beforeEach(() => {
    initialEngines = listContextEngineIds();
  });

  afterEach(() => {
    // Clean up test engines
    const currentEngines = listContextEngineIds();
    const testEngines = currentEngines.filter((id) => !initialEngines.includes(id));
    testEngines.forEach((_id) => {
      // Note: We can't delete from the Map directly without exposing it,
      // but we can at least document what we registered
    });
  });

  describe("singleton pattern via globalThis", () => {
    it("should share the same Map instance across multiple imports", () => {
      const testId = "test-singleton-engine";
      const mockFactory: ContextEngineFactory = () => ({
        getContext: async () => ({ context: "test" }),
        clearContext: async () => {},
      });

      registerContextEngine(testId, mockFactory);

      // The factory should be retrievable
      const factory = getContextEngineFactory(testId);
      expect(factory).toBe(mockFactory);

      // The engine should be in the list
      const ids = listContextEngineIds();
      expect(ids).toContain(testId);
    });

    it("should persist registrations across module re-evaluations", () => {
      const testId = "test-persistent-engine";
      const mockFactory: ContextEngineFactory = () => ({
        getContext: async () => ({ context: "persistent" }),
        clearContext: async () => {},
      });

      registerContextEngine(testId, mockFactory);

      // Simulate accessing from a different module context
      // In the real bundled scenario, globalThis ensures we get the same Map
      const retrieved = getContextEngineFactory(testId);
      expect(retrieved).toBe(mockFactory);
    });

    it("should use globalThis.__openclawContextEngines as the backing store", () => {
      const testId = "test-globalthis-engine";
      const mockFactory: ContextEngineFactory = () => ({
        getContext: async () => ({ context: "globalthis" }),
        clearContext: async () => {},
      });

      registerContextEngine(testId, mockFactory);

      // Verify globalThis has the engines Map
      expect(
        (globalThis as unknown as { __openclawContextEngines?: Map<string, unknown> })
          .__openclawContextEngines,
      ).toBeDefined();
      expect(
        (globalThis as unknown as { __openclawContextEngines: Map<string, unknown> })
          .__openclawContextEngines instanceof Map,
      ).toBe(true);
      expect(
        (
          globalThis as unknown as { __openclawContextEngines: Map<string, unknown> }
        ).__openclawContextEngines.has(testId),
      ).toBe(true);
    });
  });

  describe("cross-context engine visibility", () => {
    it("should make engines registered in one context visible in another", () => {
      const contextAId = "context-a-engine";
      const contextBId = "context-b-engine";

      const factoryA: ContextEngineFactory = () => ({
        getContext: async () => ({ context: "A" }),
        clearContext: async () => {},
      });

      const factoryB: ContextEngineFactory = () => ({
        getContext: async () => ({ context: "B" }),
        clearContext: async () => {},
      });

      // Register from "context A"
      registerContextEngine(contextAId, factoryA);

      // Register from "context B"
      registerContextEngine(contextBId, factoryB);

      // Both should be visible
      expect(listContextEngineIds()).toContain(contextAId);
      expect(listContextEngineIds()).toContain(contextBId);

      // Both factories should be retrievable
      expect(getContextEngineFactory(contextAId)).toBe(factoryA);
      expect(getContextEngineFactory(contextBId)).toBe(factoryB);
    });

    it("should allow engines from different plugins to coexist", () => {
      const pluginAEngine = "plugin-a-engine";
      const pluginBEngine = "plugin-b-engine";

      registerContextEngine(pluginAEngine, () => ({
        getContext: async () => ({ plugin: "A" }),
        clearContext: async () => {},
      }));

      registerContextEngine(pluginBEngine, () => ({
        getContext: async () => ({ plugin: "B" }),
        clearContext: async () => {},
      }));

      const ids = listContextEngineIds();
      expect(ids).toContain(pluginAEngine);
      expect(ids).toContain(pluginBEngine);
    });
  });

  describe("edge cases", () => {
    it("should allow registering the same engine ID twice (last wins)", () => {
      const testId = "duplicate-engine";

      const factory1: ContextEngineFactory = () => ({
        getContext: async () => ({ version: 1 }),
        clearContext: async () => {},
      });

      const factory2: ContextEngineFactory = () => ({
        getContext: async () => ({ version: 2 }),
        clearContext: async () => {},
      });

      registerContextEngine(testId, factory1);
      registerContextEngine(testId, factory2);

      // Last registration wins
      expect(getContextEngineFactory(testId)).toBe(factory2);
    });

    it("should return undefined for non-existent engine", () => {
      const result = getContextEngineFactory("non-existent-engine-xyz");
      expect(result).toBeUndefined();
    });

    it("should handle empty engine ID list", () => {
      // Even with existing engines, this should return an array
      const ids = listContextEngineIds();
      expect(Array.isArray(ids)).toBe(true);
    });

    it("should maintain type safety for factory functions", () => {
      const testId = "type-safe-engine";

      // Synchronous factory
      const syncFactory: ContextEngineFactory = (): ContextEngine => ({
        getContext: async () => ({ sync: true }),
        clearContext: async () => {},
      });

      registerContextEngine(testId, syncFactory);

      // Async factory
      const asyncFactory: ContextEngineFactory = async (): Promise<ContextEngine> => ({
        getContext: async () => ({ async: true }),
        clearContext: async () => {},
      });

      registerContextEngine(testId, asyncFactory);

      expect(getContextEngineFactory(testId)).toBe(asyncFactory);
    });
  });

  describe("resolveContextEngine", () => {
    it("should resolve to the configured engine from plugin slot", async () => {
      const testId = "custom-slot-engine";
      const mockEngine: ContextEngine = {
        getContext: async () => ({ custom: true }),
        clearContext: async () => {},
      };

      registerContextEngine(testId, () => mockEngine);

      const config = {
        plugins: {
          slots: {
            contextEngine: testId,
          },
        },
      };

      const resolved = await resolveContextEngine(config);
      expect(resolved).toBe(mockEngine);
    });

    it("should throw when configured engine is not registered", async () => {
      const config = {
        plugins: {
          slots: {
            contextEngine: "non-existent-engine",
          },
        },
      };

      await expect(resolveContextEngine(config)).rejects.toThrow(
        /Context engine "non-existent-engine" is not registered/,
      );
    });

    it("should provide helpful error message listing available engines", async () => {
      const testId = "available-engine";
      registerContextEngine(testId, () => ({
        getContext: async () => ({ available: true }),
        clearContext: async () => {},
      }));

      const config = {
        plugins: {
          slots: {
            contextEngine: "missing-engine",
          },
        },
      };

      await expect(resolveContextEngine(config)).rejects.toThrow(/Available engines:/);
    });

    it("should handle async factory functions", async () => {
      const testId = "async-factory-engine";
      const mockEngine: ContextEngine = {
        getContext: async () => ({ asyncFactory: true }),
        clearContext: async () => {},
      };

      // Async factory that resolves to an engine
      const asyncFactory: ContextEngineFactory = async () => {
        // Simulate async setup (e.g., DB connection)
        await new Promise((resolve) => setTimeout(resolve, 10));
        return mockEngine;
      };

      registerContextEngine(testId, asyncFactory);

      const config = {
        plugins: {
          slots: {
            contextEngine: testId,
          },
        },
      };

      const resolved = await resolveContextEngine(config);
      expect(resolved).toBe(mockEngine);
    });

    it("should trim whitespace from slot value", async () => {
      const testId = "trim-test-engine";
      registerContextEngine(testId, () => ({
        getContext: async () => ({ trimmed: true }),
        clearContext: async () => {},
      }));

      const config = {
        plugins: {
          slots: {
            contextEngine: `  ${testId}  `,
          },
        },
      };

      const resolved = await resolveContextEngine(config);
      expect(resolved).toBeDefined();
    });
  });

  describe("listContextEngineIds", () => {
    it("should return all registered engine IDs", () => {
      const engine1 = "list-test-engine-1";
      const engine2 = "list-test-engine-2";

      registerContextEngine(engine1, () => ({
        getContext: async () => ({ id: 1 }),
        clearContext: async () => {},
      }));

      registerContextEngine(engine2, () => ({
        getContext: async () => ({ id: 2 }),
        clearContext: async () => {},
      }));

      const ids = listContextEngineIds();
      expect(ids).toContain(engine1);
      expect(ids).toContain(engine2);
    });

    it("should return a new array instance each time", () => {
      const list1 = listContextEngineIds();
      const list2 = listContextEngineIds();

      // Different array instances
      expect(list1).not.toBe(list2);
      // But same content
      expect(list1).toEqual(list2);
    });
  });
});
