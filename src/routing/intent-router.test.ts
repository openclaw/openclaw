import { describe, it, expect } from "vitest";
import { resolveIntentRoute, resolveAgentRouteWithIntent } from "./intent-router.js";
import type { ResolvedAgentRoute, IntentRoutingConfig } from "./intent-router.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseRoute(overrides?: Partial<ResolvedAgentRoute>): ResolvedAgentRoute {
  return {
    agentId: "default-agent",
    channel: "telegram",
    accountId: "user-123",
    sessionKey: "agent:default-agent:telegram:user-123:direct:abc:main",
    mainSessionKey: "agent:default-agent:main",
    lastRoutePolicy: "main",
    matchedBy: "binding.channel",
    ...overrides,
  };
}

function config(overrides?: Partial<IntentRoutingConfig>): IntentRoutingConfig {
  return {
    enabled: true,
    routes: {
      complex: {
        agentId: "orchestrator",
        executionMode: "acp",
        acpBackend: "claude-code",
      },
      simple: {
        modelOverride: "claude-3-5-haiku-20241022",
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveIntentRoute
// ---------------------------------------------------------------------------

describe("resolveIntentRoute", () => {
  describe("disabled config", () => {
    it("returns base route unchanged when disabled", () => {
      const base = baseRoute();
      const result = resolveIntentRoute(base, "anything", config({ enabled: false }));
      expect(result).toEqual(base);
    });

    it("returns base route when routes map is empty", () => {
      const base = baseRoute();
      const result = resolveIntentRoute(base, "anything", config({ routes: {} }));
      expect(result).toEqual(base);
    });
  });

  describe("simple message routing", () => {
    it("applies model override for simple messages", () => {
      const base = baseRoute();
      const result = resolveIntentRoute(base, "Say hello", config());

      expect(result.modelOverride).toBe("claude-3-5-haiku-20241022");
      expect(result.matchedBy).toBe("intent:simple");
      expect(result.agentId).toBe("default-agent"); // unchanged
      expect(result.intentClassification?.category).toBe("simple");
    });
  });

  describe("complex message routing", () => {
    it("overrides agent and execution mode for complex messages", () => {
      const base = baseRoute();
      const result = resolveIntentRoute(
        base,
        "First design the schema, then implement the API endpoints",
        config(),
      );

      expect(result.agentId).toBe("orchestrator");
      expect(result.executionMode).toBe("acp");
      expect(result.acpBackend).toBe("claude-code");
      expect(result.matchedBy).toBe("intent:complex");
      expect(result.intentClassification?.category).toBe("complex");
      expect(result.intentClassification?.matchedRule).toBe("complex:first-then");
    });
  });

  describe("default category (no match)", () => {
    it("returns base route for messages that match no pattern", () => {
      const base = baseRoute();
      // 201-499 chars with no complexity patterns falls through to default
      const result = resolveIntentRoute(base, "x".repeat(300), config());

      expect(result).toEqual(base);
    });
  });

  describe("category without configured route", () => {
    it("falls back to base route when category has no route entry", () => {
      const base = baseRoute();
      const cfg = config({
        routes: {
          // Only "complex" is configured, not "simple"
          complex: { agentId: "orchestrator" },
        },
      });

      const result = resolveIntentRoute(base, "Say hello", cfg);
      // "simple" matches but has no route → fall through
      expect(result).toEqual(base);
    });
  });

  describe("partial overrides", () => {
    it("keeps base agentId when target has no agentId", () => {
      const base = baseRoute({ agentId: "original" });
      const cfg = config({
        routes: {
          simple: { modelOverride: "fast-model" },
        },
      });

      const result = resolveIntentRoute(base, "Hello", cfg);
      expect(result.agentId).toBe("original");
      expect(result.modelOverride).toBe("fast-model");
    });

    it("keeps base fields that are not overridden", () => {
      const base = baseRoute();
      const result = resolveIntentRoute(base, "Say hello", config());

      expect(result.channel).toBe(base.channel);
      expect(result.accountId).toBe(base.accountId);
      expect(result.sessionKey).toBe(base.sessionKey);
      expect(result.mainSessionKey).toBe(base.mainSessionKey);
      expect(result.lastRoutePolicy).toBe(base.lastRoutePolicy);
    });
  });

  describe("matchedBy field", () => {
    it("sets matchedBy to intent:simple for simple messages", () => {
      const result = resolveIntentRoute(baseRoute(), "Hello", config());
      expect(result.matchedBy).toBe("intent:simple");
    });

    it("sets matchedBy to intent:complex for complex messages", () => {
      const result = resolveIntentRoute(baseRoute(), "Step 1: plan. Step 2: execute.", config());
      expect(result.matchedBy).toBe("intent:complex");
    });

    it("preserves original matchedBy when no intent match", () => {
      const base = baseRoute({ matchedBy: "binding.peer" });
      const result = resolveIntentRoute(base, "x".repeat(300), config());
      expect(result.matchedBy).toBe("binding.peer");
    });
  });

  describe("intentClassification in result", () => {
    it("includes classification for matched intents", () => {
      const result = resolveIntentRoute(baseRoute(), "Collaborate on the project", config());
      expect(result.intentClassification).toBeDefined();
      expect(result.intentClassification?.category).toBe("complex");
      expect(result.intentClassification?.confidence).toBe("high");
    });

    it("has no classification for unmatched intents", () => {
      const result = resolveIntentRoute(baseRoute(), "x".repeat(300), config());
      expect(result.intentClassification).toBeUndefined();
    });
  });

  describe("custom rules", () => {
    it("uses custom rules when provided in config", () => {
      const cfg: IntentRoutingConfig = {
        enabled: true,
        rules: [
          {
            id: "custom:code",
            category: "code",
            priority: 1,
            matchers: [{ type: "keyword", keywords: ["code", "implement", "function"] }],
          },
        ],
        routes: {
          code: { agentId: "coder-agent", modelOverride: "claude-opus" },
        },
      };

      const result = resolveIntentRoute(baseRoute(), "Write a function", cfg);
      expect(result.agentId).toBe("coder-agent");
      expect(result.modelOverride).toBe("claude-opus");
      expect(result.matchedBy).toBe("intent:code");
    });
  });
});

// ---------------------------------------------------------------------------
// resolveAgentRouteWithIntent — convenience wrapper
// ---------------------------------------------------------------------------

describe("resolveAgentRouteWithIntent", () => {
  it("passes through when no intent config provided", () => {
    const base = baseRoute();
    const result = resolveAgentRouteWithIntent(base, "anything");
    expect(result).toEqual(base);
  });

  it("passes through when intent config is undefined", () => {
    const base = baseRoute();
    const result = resolveAgentRouteWithIntent(base, "anything", undefined);
    expect(result).toEqual(base);
  });

  it("passes through when disabled", () => {
    const base = baseRoute();
    const result = resolveAgentRouteWithIntent(base, "anything", config({ enabled: false }));
    expect(result).toEqual(base);
  });

  it("applies intent routing when enabled", () => {
    const base = baseRoute();
    const result = resolveAgentRouteWithIntent(base, "Say hello", config());
    expect(result.matchedBy).toBe("intent:simple");
    expect(result.modelOverride).toBe("claude-3-5-haiku-20241022");
  });

  it("applies complex routing through the wrapper", () => {
    const base = baseRoute();
    const result = resolveAgentRouteWithIntent(
      base,
      "First design, then implement the whole thing",
      config(),
    );
    expect(result.agentId).toBe("orchestrator");
    expect(result.executionMode).toBe("acp");
  });
});
