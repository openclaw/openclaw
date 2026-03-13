/**
 * Smart Router Tests
 *
 * Tests for the escalation gate system using Vitest.
 */

import { describe, it, expect } from "vitest";
import { determineLevel, executeWithGate } from "../lib/escalation-gate.js";
import { createTrace, analyzeTraces } from "../lib/trace-standard.js";
import { retrieve, store } from "../lib/unified-memory.js";

describe("Smart Router", () => {
  describe("Request Classification", () => {
    it("should classify simple lookups as RAG", () => {
      const plan = determineLevel("What's my shopping list?");
      expect(plan.level).toBe("rag");
      expect(plan.requiresAI).toBe(false);
      expect(plan.maxTokens).toBe(0);
    });

    it("should classify system commands as Workflow", () => {
      const plan = determineLevel("Run backup now");
      expect(plan.level).toBe("workflow");
      expect(plan.requiresAI).toBe(false);
    });

    it("should classify complex tasks as Agent", () => {
      const plan = determineLevel("Build a trading bot");
      expect(plan.level).toBe("agent");
      expect(plan.requiresAI).toBe(true);
      expect(plan.justification).toBeTruthy();
    });

    it("should require checkpoint for high complexity", () => {
      const plan = determineLevel("Design system architecture");
      expect(plan.level).toBe("agent");
      expect(plan.checkpoint).toBe(true);
    });
  });

  describe("Execution with Gate", () => {
    it("should route to RAG handler for simple queries", async () => {
      let handlerCalled = false;
      const result = await executeWithGate("Check status", {
        rag: async () => {
          handlerCalled = true;
          return { status: "ok" };
        },
        workflow: async () => ({ status: "workflow" }),
        agent: async () => ({ status: "agent" }),
      });

      expect(handlerCalled).toBe(true);
      expect(result).toEqual({ status: "ok" });
    });

    it("should route to Agent handler for complex tasks", async () => {
      let handlerCalled = false;
      const result = await executeWithGate("Implement feature", {
        rag: async () => ({ status: "rag" }),
        workflow: async () => ({ status: "workflow" }),
        agent: async () => {
          handlerCalled = true;
          return { code: "implemented" };
        },
      });

      expect(handlerCalled).toBe(true);
      expect(result).toEqual({ code: "implemented" });
    });
  });

  describe("Unified Memory", () => {
    it("should store and retrieve memories", () => {
      const id = store("experiences", {
        title: "Test Entry",
        content: "Test content",
        importance: 8,
      });

      expect(id).toBeTruthy();
      expect(id.startsWith("mem-")).toBe(true);
    });

    it("should find relevant memories", () => {
      // Store a test memory
      store("experiences", {
        title: "Shopping List Test",
        content: "Buy milk and eggs from the store",
        importance: 5,
      });

      // Retrieve
      const results = retrieve({ query: "shopping milk eggs", limit: 5 });
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe("Trace Standard", () => {
    it("should create a trace with ID", () => {
      const trace = createTrace("Test request");
      expect(trace.id).toBeTruthy();
      expect(trace.data.request.text).toBe("Test request");
    });

    it("should log routing decisions", () => {
      const trace = createTrace("Test");
      trace.logRouting({
        level: "rag",
        justification: "Simple lookup",
        confidence: 1.0,
      });

      expect(trace.data.routing?.level).toBe("rag");
      expect(trace.data.routing?.justification).toBe("Simple lookup");
    });

    it("should log execution steps", () => {
      const trace = createTrace("Test");
      trace.logStep({
        tool: "memory_search",
        latency: 50,
        success: true,
      });

      expect(trace.data.steps.length).toBe(1);
      expect(trace.data.steps[0]?.tool).toBe("memory_search");
      expect(trace.data.metrics.toolCalls).toBe(1);
    });

    it("should log outcomes", () => {
      const trace = createTrace("Test");
      trace.logOutcome({ success: true, result: "Done" });

      expect(trace.data.outcome?.success).toBe(true);
      expect(trace.data.completedAt).toBeTruthy();
    });

    it("should handle empty traces gracefully", () => {
      const analysis = analyzeTraces();
      expect(analysis.total).toBeGreaterThanOrEqual(0);
      expect(analysis.avgDuration).toBe(0);
      expect(analysis.avgTokens).toBe(0);
    });
  });
});
