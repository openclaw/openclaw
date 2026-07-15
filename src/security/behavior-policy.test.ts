// Unit tests for agent-behavior governance policy.

import type { OpenClawConfig } from "../config/types.openclaw.js";
import { describe, it, assert } from "../test-utils/testing.js";
import {
  type BehaviorPolicyRule,
  type ResolvedBehaviorRule,
  resolveBehaviorPolicy,
  resolveBehaviorRules,
  buildBehaviorPolicyPrompt,
  validateBehaviorOutput,
} from "./behavior-policy.js";

const SAMPLE_RULE: BehaviorPolicyRule = {
  id: "test-no-secrets",
  description: "Never disclose API keys or auth tokens.",
  enforce: "Never disclose the operator's API keys, auth tokens, or private credentials.",
};

const SAMPLE_RULE_GUIDE: BehaviorPolicyRule = {
  id: "test-politeness",
  description: "Be polite.",
  enforce: "Always respond politely and respectfully.",
  mode: "guide",
};

function makeConfig(rules?: BehaviorPolicyRule[], exec?: Record<string, unknown>): OpenClawConfig {
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

describe("behavior-policy", () => {
  describe("resolveBehaviorPolicy", () => {
    it("returns undefined when config is undefined", () => {
      assert.strictEqual(resolveBehaviorPolicy(undefined), undefined);
    });

    it("returns undefined when behaviorPolicy is absent", () => {
      assert.strictEqual(resolveBehaviorPolicy({}), undefined);
    });

    it("returns undefined when behaviorPolicy is not enabled", () => {
      const cfg = {
        security: { behaviorPolicy: { enabled: false } },
      } as unknown as OpenClawConfig;
      assert.strictEqual(resolveBehaviorPolicy(cfg), undefined);
    });

    it("returns the policy config when enabled", () => {
      const cfg = makeConfig([SAMPLE_RULE]);
      const policy = resolveBehaviorPolicy(cfg);
      assert.ok(policy);
      assert.strictEqual(policy.enabled, true);
    });
  });

  describe("resolveBehaviorRules", () => {
    it("returns undefined when policy is disabled", () => {
      assert.strictEqual(resolveBehaviorRules(undefined), undefined);
    });

    it("returns undefined when no rules are defined", () => {
      const cfg = {
        security: { behaviorPolicy: { enabled: true } },
      } as unknown as OpenClawConfig;
      assert.strictEqual(resolveBehaviorRules(cfg), undefined);
    });

    it("returns resolved rules with defaults applied", () => {
      const cfg = makeConfig([SAMPLE_RULE, SAMPLE_RULE_GUIDE]);
      const rules = resolveBehaviorRules(cfg);
      assert.ok(rules);
      assert.strictEqual(rules.length, 2);
      assert.strictEqual(rules[0].id, "test-no-secrets");
      assert.strictEqual(rules[0].mode, "enforce");
      assert.strictEqual(rules[1].id, "test-politeness");
      assert.strictEqual(rules[1].mode, "guide");
    });
  });

  describe("buildBehaviorPolicyPrompt", () => {
    it("returns empty string for undefined rules", () => {
      assert.strictEqual(buildBehaviorPolicyPrompt(undefined), "");
    });

    it("returns empty string for empty rules", () => {
      assert.strictEqual(buildBehaviorPolicyPrompt([]), "");
    });

    it("builds enforce block for a single rule", () => {
      const rules: ResolvedBehaviorRule[] = [
        {
          id: "r1",
          description: "desc",
          enforce: "Do the thing",
          mode: "enforce",
        },
      ];
      const prompt = buildBehaviorPolicyPrompt(rules);
      assert.ok(prompt.includes('<enforce id="r1">'));
      assert.ok(prompt.includes("Do the thing"));
      assert.ok(prompt.includes("MUST comply"));
    });

    it("uses guide tag for guide-mode rules", () => {
      const rules: ResolvedBehaviorRule[] = [
        { id: "r2", description: "", enforce: "Be polite", mode: "guide" },
      ];
      const prompt = buildBehaviorPolicyPrompt(rules);
      assert.ok(prompt.includes('<guide id="r2">'));
      assert.ok(prompt.includes("Be polite"));
    });

    it("includes multiple rules", () => {
      const rules: ResolvedBehaviorRule[] = [
        { id: "a", description: "", enforce: "Rule A", mode: "enforce" },
        { id: "b", description: "", enforce: "Rule B", mode: "guide" },
      ];
      const prompt = buildBehaviorPolicyPrompt(rules);
      assert.ok(prompt.includes("Rule A"));
      assert.ok(prompt.includes("Rule B"));
    });

    it("escapes XML in rule content", () => {
      const rules: ResolvedBehaviorRule[] = [
        {
          id: "xss",
          description: "",
          enforce: "Never use <script> tags",
          mode: "enforce",
        },
      ];
      const prompt = buildBehaviorPolicyPrompt(rules);
      assert.ok(prompt.includes("&lt;script&gt;"));
      assert.ok(!prompt.includes("<script>"));
    });
  });

  describe("validateBehaviorOutput", () => {
    it("returns pass when no rules are active", async () => {
      const result = await validateBehaviorOutput({
        rules: undefined,
        output: "hello",
      });
      assert.strictEqual(result.kind, "pass");
    });

    it("returns pass when rules are empty", async () => {
      const result = await validateBehaviorOutput({
        rules: [],
        output: "hello",
      });
      assert.strictEqual(result.kind, "pass");
    });

    it("returns pass for clean output with enforce rules", async () => {
      const rules: ResolvedBehaviorRule[] = [
        {
          id: "no-secrets",
          description: "",
          enforce: "Never disclose API keys",
          mode: "enforce",
        },
      ];
      const result = await validateBehaviorOutput({
        rules,
        output: "Here is some general help.",
      });
      assert.strictEqual(result.kind, "pass");
    });

    it("returns pass with violations suggestion for potential rule conflicts", async () => {
      const rules: ResolvedBehaviorRule[] = [
        {
          id: "no-secrets",
          description: "",
          enforce: "Never disclose API keys",
          mode: "enforce",
        },
      ];
      const result = await validateBehaviorOutput({
        rules,
        output: "My API key is sk-abc123",
      });
      assert.strictEqual(result.kind, "pass");
      assert.ok(result.violations);
      assert.strictEqual(result.violations.length, 1);
      assert.strictEqual(result.violations[0].ruleId, "no-secrets");
    });

    it("skips heuristic check for guide-mode rules", async () => {
      const rules: ResolvedBehaviorRule[] = [
        {
          id: "polite",
          description: "",
          enforce: "Never be rude",
          mode: "guide",
        },
      ];
      const result = await validateBehaviorOutput({
        rules,
        output: "You are an idiot",
      });
      assert.strictEqual(result.kind, "pass");
      assert.strictEqual(result.violations?.length ?? 0, 0);
    });
  });
});
