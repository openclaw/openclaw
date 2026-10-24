import { describe, expect, it } from "vitest";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import { isToolAllowed, resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";
import { buildDeclaredToolAllowlistContext } from "./tool-policy-declared-context.js";
import {
  isRuntimeToolAllowed,
  createRuntimeToolMatcher,
  isToolAllowedByPolicyName,
} from "./tool-policy-match.js";
import {
  collectExplicitAllowlist,
  couldNormalizeToolNamePrefixToAllowedTool,
  DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
  hasRestrictiveAllowPolicy,
  resolveToolProfilePolicy,
} from "./tool-policy.js";

describe("tool-policy", () => {
  it("keeps shipped dispatcher policies effective in runtime and sandbox matching", () => {
    expect(isToolAllowedByPolicyName("dispatch_action", { deny: ["tool_call"] })).toBe(false);
    expect(isToolAllowedByPolicyName("dispatch_action", { allow: ["tool_call"] })).toBe(true);
    expect(isRuntimeToolAllowed("dispatch_action", ["tool_call"])).toBe(true);
    expect(isRuntimeToolAllowed("exec", ["tool_call"])).toBe(false);
    expect(isToolAllowedByPolicyName("dispatch_action", { deny: ["tool_*"] })).toBe(false);
    expect(isToolAllowedByPolicyName("dispatch_action", { allow: ["tool_*"] })).toBe(true);
  });
  it.each([
    { deny: "*", expected: [] },
    { deny: "a*__*", expected: ["beta"] },
  ])("preserves discoverable MCP namespaces for deny=$deny", ({ deny, expected }) => {
    const declared = buildDeclaredToolAllowlistContext({
      config: {
        plugins: { enabled: false },
        mcp: { servers: { alpha: { command: "alpha" }, beta: { command: "beta" } } },
      },
      toolDenylist: [deny],
    });
    expect([...(declared?.mcpServerNames ?? [])]).toEqual(expected);
  });

  it("resolves known profiles and ignores unknown ones", () => {
    expect(resolveToolProfilePolicy("coding")?.allow).toEqual(
      expect.arrayContaining(["read", "automations", "gateway"]),
    );
    expect(resolveToolProfilePolicy("nope")).toBeUndefined();
  });

  it("matches literal constructor prefixes only when allowed", () => {
    const name = "constructor";
    expect(couldNormalizeToolNamePrefixToAllowedTool(name.slice(0, 3), new Set([name]))).toBe(true);
    expect(couldNormalizeToolNamePrefixToAllowedTool("other", new Set([name]))).toBe(false);
    expect(couldNormalizeToolNamePrefixToAllowedTool(name, new Set(["other"]))).toBe(false);
  });

  it.each(["ba", "cron"])("retains declared alias prefix %s", (prefix) => {
    const allowed = new Set(["exec", "apply_patch", "automations"]);
    expect(couldNormalizeToolNamePrefixToAllowedTool(prefix, allowed)).toBe(true);
  });

  it.each<[string[] | undefined, string[]]>([
    [undefined, ["lobster", DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY]],
    [[], ["*", "lobster"]],
  ])("preserves additive allowlist provenance with allow=%j", (allow, expected) => {
    const policy = pickSandboxToolPolicy({ allow, alsoAllow: ["lobster"] });
    expect(collectExplicitAllowlist([policy])).toEqual(expected);
    expect(hasRestrictiveAllowPolicy(policy)).toBe(false);
  });

  it("still treats explicit bounded allowlists as restrictive", () => {
    expect(hasRestrictiveAllowPolicy(pickSandboxToolPolicy({ allow: ["read"] }))).toBe(true);
  });
  it("applies allow and deny to literal constructor", () => {
    const name = "constructor";
    const allow = { allow: [` ${name.toUpperCase()} `] };
    const deny = { allow: ["*"], deny: [` ${name.toUpperCase()} `] };
    for (const matches of [
      (policy: SandboxToolPolicy, tool: string) => isToolAllowed(policy, tool),
      (policy: SandboxToolPolicy, tool: string) => isToolAllowedByPolicyName(tool, policy),
    ]) {
      expect(matches(allow, name)).toBe(true);
      expect(matches(allow, "other")).toBe(false);
      expect(matches(deny, name)).toBe(false);
      expect(matches(deny, "other")).toBe(true);
    }
  });
  const resolve = (allow: string[], deny: string[]) =>
    resolveSandboxToolPolicyForAgent({ tools: { sandbox: { tools: { allow, deny } } } }, undefined);
  it.each([
    { allow: [], deny: ["browser"], expected: [] },
    { allow: ["read"], deny: ["browser"], expected: ["read", "view_image"] },
    { allow: ["read"], deny: ["view_image"], expected: ["read"] },
  ])("resolves sandbox allow=$allow deny=$deny", ({ allow, deny, expected }) => {
    const resolved = resolve(allow, deny);
    expect(resolved).toMatchObject({
      allow: expected,
      deny,
      sources: { allow: { source: "global", key: "tools.sandbox.tools.allow" } },
    });
    if (allow.length === 0) {
      expect(resolved.allow).toStrictEqual([]);
      expect(isToolAllowed(resolved, "read")).toBe(true);
      expect(isToolAllowed(resolved, "browser")).toBe(false);
    }
  });
  it("denies the renamed tool through persisted legacy deny lists", () => {
    expect(isToolAllowedByPolicyName("automations", { deny: ["cron"] })).toBe(false);
  });
  it("does not deny apply_patch when write is denied", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { deny: ["write"] })).toBe(true);
  });

  it("keeps runtime write compatibility out of construction planning", () => {
    expect(isRuntimeToolAllowed("apply_patch", ["write"])).toBe(true);
    expect(createRuntimeToolMatcher(["write"], false)("apply_patch")).toBe(false);
    expect(isRuntimeToolAllowed("apply_patch", ["apply-patch"])).toBe(true);
    expect(isRuntimeToolAllowed("apply_patch", ["apply_*"])).toBe(true);
    expect(isRuntimeToolAllowed("apply_patch", ["group:fs"])).toBe(true);
  });
});
