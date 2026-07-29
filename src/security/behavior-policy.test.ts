// Unit tests for agent-behavior governance policy.

import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveBehaviorRules,
  buildBehaviorPolicyPrompt,
  validateBehaviorOutput,
} from "./behavior-policy.js";

function makeConfig(
  rules?: Array<{
    id: string;
    description?: string;
    enforce: string;
    mode?: "enforce" | "guide";
  }>,
  exec?: Record<string, unknown>,
): OpenClawConfig {
  return {
    security: {
      behaviorPolicy: {
        enabled: true,
        ...(rules ? { rules } : {}),
        ...(exec ? { exec } : {}),
      },
    },
  } as unknown as OpenClawConfig;
}

const SAMPLE_RULE = {
  id: "test-no-secrets",
  description: "Never disclose API keys or auth tokens.",
  enforce: "Never disclose the operator's API keys, auth tokens, or private credentials.",
};

const SAMPLE_RULE_GUIDE = {
  id: "test-politeness",
  description: "Be polite.",
  enforce: "Always respond politely and respectfully.",
  mode: "guide" as const,
};

describe("behavior-policy", () => {
  describe("resolveBehaviorRules", () => {
    it("returns undefined when config is undefined", () => {
      expect(resolveBehaviorRules(undefined)).toBeUndefined();
    });

    it("returns undefined when no rules are defined", () => {
      const cfg = {
        security: { behaviorPolicy: { enabled: true } },
      } as unknown as OpenClawConfig;
      expect(resolveBehaviorRules(cfg)).toBeUndefined();
    });

    it("returns resolved rules with defaults applied", () => {
      const cfg = makeConfig([SAMPLE_RULE, SAMPLE_RULE_GUIDE]);
      const rules = resolveBehaviorRules(cfg);
      expect(rules).toBeDefined();
      expect(rules!).toHaveLength(2);
      expect(rules![0]!.id).toBe("test-no-secrets");
      expect(rules![0]!.mode).toBe("enforce");
      expect(rules![1]!.id).toBe("test-politeness");
      expect(rules![1]!.mode).toBe("guide");
    });
  });

  describe("buildBehaviorPolicyPrompt", () => {
    it("returns empty string for undefined rules", () => {
      expect(buildBehaviorPolicyPrompt(undefined)).toBe("");
    });

    it("returns empty string for empty rules", () => {
      expect(buildBehaviorPolicyPrompt([])).toBe("");
    });

    it("builds enforce block for a single rule", () => {
      const rules = [
        {
          id: "r1",
          description: "desc",
          enforce: "Do the thing",
          mode: "enforce" as const,
        },
      ];
      const prompt = buildBehaviorPolicyPrompt(rules);
      expect(prompt).toContain('<enforce id="r1">');
      expect(prompt).toContain("Do the thing");
      expect(prompt).toContain("MUST comply");
    });

    it("uses guide tag for guide-mode rules", () => {
      const rules = [
        {
          id: "r2",
          description: "",
          enforce: "Be polite",
          mode: "guide" as const,
        },
      ];
      const prompt = buildBehaviorPolicyPrompt(rules);
      expect(prompt).toContain('<guide id="r2">');
      expect(prompt).toContain("Be polite");
    });

    it("includes multiple rules", () => {
      const rules = [
        {
          id: "a",
          description: "",
          enforce: "Rule A",
          mode: "enforce" as const,
        },
        { id: "b", description: "", enforce: "Rule B", mode: "guide" as const },
      ];
      const prompt = buildBehaviorPolicyPrompt(rules);
      expect(prompt).toContain("Rule A");
      expect(prompt).toContain("Rule B");
    });

    it("escapes XML in rule content", () => {
      const rules = [
        {
          id: "xss",
          description: "",
          enforce: "Never use <script> tags",
          mode: "enforce" as const,
        },
      ];
      const prompt = buildBehaviorPolicyPrompt(rules);
      expect(prompt).toContain("&lt;script&gt;");
      expect(prompt).not.toContain("<script>");
    });
  });

  describe("validateBehaviorOutput", () => {
    it("returns pass when no rules are active", async () => {
      const result = await validateBehaviorOutput({
        rules: undefined,
        output: "hello",
      });
      expect(result.kind).toBe("pass");
    });

    it("returns pass when rules are empty", async () => {
      const result = await validateBehaviorOutput({
        rules: [],
        output: "hello",
      });
      expect(result.kind).toBe("pass");
    });

    it("returns pass for clean output with enforce rules", async () => {
      const rules = [
        {
          id: "no-secrets",
          description: "",
          enforce: "Never disclose API keys",
          mode: "enforce" as const,
        },
      ];
      const result = await validateBehaviorOutput({
        rules,
        output: "Here is some general help.",
      });
      expect(result.kind).toBe("pass");
    });

    it("returns pass with violations suggestion for potential rule conflicts", async () => {
      const rules = [
        {
          id: "no-secrets",
          description: "",
          enforce: "Never disclose API keys",
          mode: "enforce" as const,
        },
      ];
      const result = await validateBehaviorOutput({
        rules,
        output: "I will disclose API keys: sk-abc123",
      });
      expect(result.kind).toBe("pass");
      if (result.kind === "pass") {
        expect(result.violations).toBeDefined();
        expect(result.violations!.length).toBe(1);
        expect(result.violations![0]!.ruleId).toBe("no-secrets");
      }
    });

    it("skips heuristic check for guide-mode rules", async () => {
      const rules = [
        {
          id: "polite",
          description: "",
          enforce: "Never be rude",
          mode: "guide" as const,
        },
      ];
      const result = await validateBehaviorOutput({
        rules,
        output: "You are an idiot",
      });
      expect(result.kind).toBe("pass");
      if (result.kind === "pass") {
        expect(result.violations?.length ?? 0).toBe(0);
      }
    });
  });
});
