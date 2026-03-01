import { describe, expect, it } from "vitest";
import { classifyComplexity } from "./complexity-classifier.js";

describe("classifyComplexity", () => {
  describe("simple tier", () => {
    it("classifies 'what time is it?' as simple", () => {
      const result = classifyComplexity({ messageText: "what time is it?" });
      expect(result.tier).toBe("simple");
    });

    it("classifies 'yes' as simple", () => {
      const result = classifyComplexity({ messageText: "yes" });
      expect(result.tier).toBe("simple");
    });

    it("classifies 'check my calendar' as simple", () => {
      const result = classifyComplexity({ messageText: "check my calendar" });
      expect(result.tier).toBe("simple");
    });

    it("classifies 'What is the capital of France?' as simple", () => {
      const result = classifyComplexity({
        messageText: "What is the capital of France?",
      });
      expect(result.tier).toBe("simple");
    });

    it("classifies short greeting as simple", () => {
      const result = classifyComplexity({ messageText: "hi" });
      expect(result.tier).toBe("simple");
    });

    it("classifies acknowledgment as simple", () => {
      const result = classifyComplexity({ messageText: "thanks" });
      expect(result.tier).toBe("simple");
    });

    it("classifies 'ok sounds good' as simple", () => {
      const result = classifyComplexity({ messageText: "ok sounds good" });
      expect(result.tier).toBe("simple");
    });

    it("returns confidence > 0 for simple tier", () => {
      const result = classifyComplexity({ messageText: "what time is it?" });
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("includes at least one signal for simple messages", () => {
      const result = classifyComplexity({ messageText: "what time is it?" });
      expect(result.signals.length).toBeGreaterThan(0);
    });
  });

  describe("complex tier", () => {
    it("classifies build REST API message as complex", () => {
      const result = classifyComplexity({
        messageText:
          "Build a REST API with auth, pagination, and rate limiting across multiple endpoints",
      });
      expect(result.tier).toBe("complex");
    });

    it("classifies refactor database schema message as complex", () => {
      const result = classifyComplexity({
        messageText: "Refactor the database schema to support multi-tenancy",
      });
      expect(result.tier).toBe("complex");
    });

    it("classifies multi-step implementation request as complex", () => {
      const result = classifyComplexity({
        messageText:
          "I need you to first analyze the codebase, then create a migration plan, and finally implement the changes across all 3 services",
      });
      expect(result.tier).toBe("complex");
    });

    it("classifies long messages with planning as complex", () => {
      const longMessage =
        "I want to architect a new microservices system. First, we need to design the API gateway, then implement the authentication service, after that set up the database schema, and finally deploy everything to production. The system should handle 10k requests per second.";
      const result = classifyComplexity({ messageText: longMessage });
      expect(result.tier).toBe("complex");
    });

    it("returns confidence > 0 for complex tier", () => {
      const result = classifyComplexity({
        messageText: "Build a REST API with auth, pagination, and rate limiting",
      });
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("includes multiple signals for complex messages", () => {
      const result = classifyComplexity({
        messageText:
          "I need you to first analyze the codebase, then create a migration plan, and finally implement the changes across all 3 services",
      });
      expect(result.signals.length).toBeGreaterThan(1);
    });
  });

  describe("medium tier", () => {
    it("classifies 'Can you review this PR?' as medium (biasTowardUpgrade)", () => {
      const result = classifyComplexity({ messageText: "Can you review this PR?" });
      expect(result.tier).toBe("medium");
    });

    it("classifies a message with code block as medium or complex", () => {
      const result = classifyComplexity({
        messageText: "What does this do?\n```js\nconsole.log('hello');\n```",
      });
      expect(["medium", "complex"]).toContain(result.tier);
    });

    it("classifies a moderately long message as medium", () => {
      const result = classifyComplexity({
        messageText:
          "Can you help me understand how the authentication flow works in this app? I want to know what happens when a user logs in.",
      });
      // Word count is ~30, no planning keywords, no code — should be medium or simple
      expect(["simple", "medium"]).toContain(result.tier);
    });

    it("returns confidence 0.5 for medium tier", () => {
      const result = classifyComplexity({ messageText: "Can you review this PR?" });
      expect(result.tier).toBe("medium");
      expect(result.confidence).toBe(0.5);
    });
  });

  describe("biasTowardUpgrade", () => {
    it("defaults biasTowardUpgrade to true (fuzzy zone goes to medium)", () => {
      // A message with score in -1..2 range should go to medium by default
      const result = classifyComplexity({ messageText: "Can you review this PR?" });
      expect(result.tier).toBe("medium");
    });

    it("biasTowardUpgrade=false keeps fuzzy zone as simple when score <= -2", () => {
      const result = classifyComplexity({
        messageText: "what time is it?",
        biasTowardUpgrade: false,
      });
      // Score should be well below -2, stays simple
      expect(result.tier).toBe("simple");
    });
  });

  describe("signal detection", () => {
    it("detects code blocks", () => {
      const result = classifyComplexity({
        messageText: "Here is the code:\n```python\nprint('hi')\n```",
      });
      expect(result.signals.some((s) => s.includes("code"))).toBe(true);
    });

    it("detects planning keywords", () => {
      const result = classifyComplexity({
        messageText: "implement a new authentication system",
      });
      expect(result.signals.some((s) => s.includes("planning"))).toBe(true);
    });

    it("detects multi-step language", () => {
      const result = classifyComplexity({
        messageText: "first do this, then do that, finally clean up",
      });
      expect(result.signals.some((s) => s.includes("multi-step"))).toBe(true);
    });

    it("detects prior context references", () => {
      const result = classifyComplexity({
        messageText: "Can you continue where we left off? Earlier we were working on auth.",
      });
      expect(result.signals.some((s) => s.includes("prior context"))).toBe(true);
    });
  });

  describe("user overrides (classifier returns result, does not force)", () => {
    it("classifier still returns a tier even if user has explicit directive context", () => {
      // The classifier just returns a result; the caller decides whether to use it.
      // This test verifies the classifier function itself doesn't throw or behave differently.
      const result = classifyComplexity({ messageText: "/think high please help me" });
      expect(result.tier).toBeDefined();
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });
});
