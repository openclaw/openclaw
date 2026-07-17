import { describe, expect, it, vi } from "vitest";
import type { PluginTrustedToolPolicyRegistryRegistration } from "./registry-types.js";
import { getTrustedToolPolicyMatcherScope, runTrustedToolPolicies } from "./trusted-tool-policy.js";

function policyRegistration(
  overrides: Partial<PluginTrustedToolPolicyRegistryRegistration["policy"]>,
): PluginTrustedToolPolicyRegistryRegistration {
  return {
    pluginId: "test-plugin",
    source: "test",
    policy: {
      id: "test-policy",
      description: "test policy",
      evaluate: () => ({ block: true, blockReason: "blocked by test" }),
      ...overrides,
    },
  };
}

describe("trusted tool policy matchers", () => {
  it("skips scoped policies for non-matching tools", async () => {
    const evaluate = vi.fn(() => ({ block: true as const, blockReason: "scoped" }));
    const registry = {
      trustedToolPolicies: [policyRegistration({ matcher: ["message"], evaluate })],
    };

    const execResult = await runTrustedToolPolicies(
      { toolName: "exec", params: {} },
      { toolName: "exec" },
      { registry },
    );
    expect(execResult).toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();

    const messageResult = await runTrustedToolPolicies(
      { toolName: "message", params: {} },
      { toolName: "message" },
      { registry },
    );
    expect(messageResult?.block).toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("matches scoped policies through tool-name aliases", async () => {
    const evaluate = vi.fn(() => undefined);
    const registry = {
      trustedToolPolicies: [policyRegistration({ matcher: ["Bash"], evaluate })],
    };
    await runTrustedToolPolicies(
      { toolName: "exec", params: {} },
      { toolName: "exec" },
      {
        registry,
      },
    );
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("runs unscoped policies for every tool", async () => {
    const registry = { trustedToolPolicies: [policyRegistration({})] };
    const result = await runTrustedToolPolicies(
      { toolName: "exec", params: {} },
      { toolName: "exec" },
      { registry },
    );
    expect(result?.block).toBe(true);
  });
});

describe("getTrustedToolPolicyMatcherScope", () => {
  it("unions scoped policy matchers with normalized spellings", () => {
    const registry = {
      trustedToolPolicies: [
        policyRegistration({ matcher: ["Bash"] }),
        policyRegistration({ matcher: ["message"] }),
      ],
    };
    expect(getTrustedToolPolicyMatcherScope(registry)).toEqual({
      matchAll: false,
      toolNames: ["Bash", "exec", "message"],
    });
  });

  it("forces match-all when any policy is unscoped", () => {
    const registry = {
      trustedToolPolicies: [policyRegistration({ matcher: ["message"] }), policyRegistration({})],
    };
    expect(getTrustedToolPolicyMatcherScope(registry)).toEqual({ matchAll: true });
  });

  it("treats unreadable policies as match-all so they stay fail-closed", () => {
    const hostile = {
      pluginId: "hostile-plugin",
      source: "test",
      get policy(): PluginTrustedToolPolicyRegistryRegistration["policy"] {
        throw new Error("unreadable");
      },
    } satisfies PluginTrustedToolPolicyRegistryRegistration;
    expect(getTrustedToolPolicyMatcherScope({ trustedToolPolicies: [hostile] })).toEqual({
      matchAll: true,
    });
  });
});
