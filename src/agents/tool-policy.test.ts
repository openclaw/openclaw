/**
 * Regression coverage for core tool allow/deny policy helpers.
 * Verifies sandbox policy resolution, explicit lists, and tool matching.
 */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
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
    const coding = resolveToolProfilePolicy("coding");
    expect(coding?.allow).toContain("read");
    expect(coding?.allow).toContain("automations");
    expect(coding?.allow).toContain("gateway");
    expect(resolveToolProfilePolicy("nope")).toBeUndefined();
  });

  it.each(["constructor"])("matches literal %s prefixes only when allowed", (name) => {
    expect(couldNormalizeToolNamePrefixToAllowedTool(name.slice(0, 3), new Set([name]))).toBe(true);
    expect(couldNormalizeToolNamePrefixToAllowedTool("other", new Set([name]))).toBe(false);
    expect(couldNormalizeToolNamePrefixToAllowedTool(name, new Set(["other"]))).toBe(false);
  });

  it.each(["ba", "cron"])("retains declared alias prefix %s", (prefix) => {
    expect(
      couldNormalizeToolNamePrefixToAllowedTool(
        prefix,
        new Set(["exec", "apply_patch", "automations"]),
      ),
    ).toBe(true);
  });

  it("uses alsoAllow entries for plugin discovery without the synthetic allow-all", () => {
    expect(collectExplicitAllowlist([pickSandboxToolPolicy({ alsoAllow: ["lobster"] })])).toEqual([
      "lobster",
      DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
    ]);
    expect(
      collectExplicitAllowlist([pickSandboxToolPolicy({ allow: [], alsoAllow: ["lobster"] })]),
    ).toEqual(["*", "lobster"]);
  });

  it("does not treat additive allow-all policies as restrictive", () => {
    expect(hasRestrictiveAllowPolicy(pickSandboxToolPolicy({ alsoAllow: ["optional-demo"] }))).toBe(
      false,
    );
    expect(
      hasRestrictiveAllowPolicy(pickSandboxToolPolicy({ allow: [], alsoAllow: ["optional-demo"] })),
    ).toBe(false);
  });

  it("still treats explicit bounded allowlists as restrictive", () => {
    expect(hasRestrictiveAllowPolicy(pickSandboxToolPolicy({ allow: ["read"] }))).toBe(true);
  });
});

describe("sandbox tool policy", () => {
  it.each(["constructor"])("applies allow and deny to literal %s", (name) => {
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
});

describe("resolveSandboxToolPolicyForAgent", () => {
  it("keeps allow-all semantics when allow is []", () => {
    const cfg = {
      tools: { sandbox: { tools: { allow: [], deny: ["browser"] } } },
    } as unknown as OpenClawConfig;

    const resolved = resolveSandboxToolPolicyForAgent(cfg, undefined);
    expect(resolved.sources.allow).toEqual({
      source: "global",
      key: "tools.sandbox.tools.allow",
    });
    expect(resolved.allow).toStrictEqual([]);
    expect(resolved.deny).toEqual(["browser"]);

    const policy: SandboxToolPolicy = { allow: resolved.allow, deny: resolved.deny };
    expect(isToolAllowed(policy, "read")).toBe(true);
    expect(isToolAllowed(policy, "browser")).toBe(false);
  });

  it("auto-adds image to explicit allowlists unless denied", () => {
    const cfg = {
      tools: { sandbox: { tools: { allow: ["read"], deny: ["browser"] } } },
    } as unknown as OpenClawConfig;

    const resolved = resolveSandboxToolPolicyForAgent(cfg, undefined);
    expect(resolved.allow).toEqual(["read", "view_image"]);
    expect(resolved.deny).toEqual(["browser"]);
  });

  it("does not auto-add view_image when explicitly denied", () => {
    const cfg = {
      tools: { sandbox: { tools: { allow: ["read"], deny: ["view_image"] } } },
    } as unknown as OpenClawConfig;

    const resolved = resolveSandboxToolPolicyForAgent(cfg, undefined);
    expect(resolved.allow).toEqual(["read"]);
    expect(resolved.deny).toEqual(["view_image"]);
  });
});

describe("isToolAllowedByPolicyName — legacy scheduler tool name (RFC 0026)", () => {
  it("denies the renamed tool through persisted legacy deny lists", () => {
    expect(isToolAllowedByPolicyName("automations", { deny: ["cron"] })).toBe(false);
  });
});

describe("isToolAllowedByPolicyName — apply_patch / write deny decoupling (#76749)", () => {
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
