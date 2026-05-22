import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import { isToolAllowed, resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import { TOOL_POLICY_CONFORMANCE } from "./tool-policy.conformance.js";
import {
  collectExplicitAllowlist,
  DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
  expandToolGroups,
  normalizeToolName,
  resolveToolProfilePolicy,
  TOOL_GROUPS,
} from "./tool-policy.js";

describe("tool-policy", () => {
  it("expands groups and normalizes aliases", () => {
    const expanded = expandToolGroups(["group:runtime", "BASH", "apply-patch", "group:fs"]);
    const set = new Set(expanded);
    expect(set.has("exec")).toBe(true);
    expect(set.has("process")).toBe(true);
    expect(set.has("bash")).toBe(false);
    expect(set.has("apply_patch")).toBe(true);
    expect(set.has("read")).toBe(true);
    expect(set.has("write")).toBe(true);
    expect(set.has("edit")).toBe(true);
  });

  it("resolves known profiles and ignores unknown ones", () => {
    const coding = resolveToolProfilePolicy("coding");
    expect(coding?.allow).toContain("read");
    expect(coding?.allow).toContain("cron");
    expect(coding?.allow).not.toContain("gateway");
    expect(resolveToolProfilePolicy("nope")).toBeUndefined();
  });

  it("includes core tool groups in group:openclaw", () => {
    const group = TOOL_GROUPS["group:openclaw"];
    expect(group).toContain("browser");
    expect(group).toContain("message");
    expect(group).toContain("subagents");
    expect(group).toContain("session_status");
    expect(group).toContain("tts");
  });

  it("normalizes tool names and aliases", () => {
    expect(normalizeToolName(" BASH ")).toBe("exec");
    expect(normalizeToolName("apply-patch")).toBe("apply_patch");
    expect(normalizeToolName("READ")).toBe("read");
  });

  it("collects explicit allowlist entries", () => {
    expect(
      collectExplicitAllowlist([
        {
          allow: ["*", "optional-demo"],
        },
      ]),
    ).toContain("optional-demo");
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

  it("preserves explicit alsoAllow wildcards for plugin discovery", () => {
    expect(collectExplicitAllowlist([pickSandboxToolPolicy({ alsoAllow: ["*"] })])).toEqual(["*"]);
    expect(collectExplicitAllowlist([pickSandboxToolPolicy({ alsoAllow: [" * "] })])).toEqual([
      "*",
    ]);
  });
});

describe("TOOL_POLICY_CONFORMANCE", () => {
  it("matches exported TOOL_GROUPS exactly", () => {
    expect(TOOL_POLICY_CONFORMANCE.toolGroups).toEqual(TOOL_GROUPS);
  });

  it("is JSON-serializable", () => {
    const serialized = JSON.stringify(TOOL_POLICY_CONFORMANCE);
    expect(JSON.parse(serialized)).toEqual({ toolGroups: TOOL_GROUPS });
  });
});

describe("sandbox tool policy", () => {
  it("allows all tools with * allow", () => {
    const policy: SandboxToolPolicy = { allow: ["*"], deny: [] };
    expect(isToolAllowed(policy, "browser")).toBe(true);
  });

  it("denies all tools with * deny", () => {
    const policy: SandboxToolPolicy = { allow: [], deny: ["*"] };
    expect(isToolAllowed(policy, "read")).toBe(false);
  });

  it("supports wildcard patterns", () => {
    const policy: SandboxToolPolicy = { allow: ["web_*"] };
    expect(isToolAllowed(policy, "web_fetch")).toBe(true);
    expect(isToolAllowed(policy, "read")).toBe(false);
  });

  it("applies deny before allow", () => {
    const policy: SandboxToolPolicy = { allow: ["*"], deny: ["web_*"] };
    expect(isToolAllowed(policy, "web_fetch")).toBe(false);
    expect(isToolAllowed(policy, "read")).toBe(true);
  });

  it("treats empty allowlist as allow-all (with deny exceptions)", () => {
    const policy: SandboxToolPolicy = { allow: [], deny: ["web_*"] };
    expect(isToolAllowed(policy, "web_fetch")).toBe(false);
    expect(isToolAllowed(policy, "read")).toBe(true);
  });

  it("expands tool groups + aliases in patterns", () => {
    const policy: SandboxToolPolicy = {
      allow: ["group:fs", "BASH"],
      deny: ["apply_*"],
    };
    expect(isToolAllowed(policy, "read")).toBe(true);
    expect(isToolAllowed(policy, "exec")).toBe(true);
    expect(isToolAllowed(policy, "apply_patch")).toBe(false);
  });

  it("normalizes whitespace + case", () => {
    const policy: SandboxToolPolicy = { allow: [" WEB_* "] };
    expect(isToolAllowed(policy, "WEB_FETCH")).toBe(true);
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
    expect(resolved.allow).toEqual(["read", "image"]);
    expect(resolved.deny).toEqual(["browser"]);
  });

  it("does not auto-add image when explicitly denied", () => {
    const cfg = {
      tools: { sandbox: { tools: { allow: ["read"], deny: ["image"] } } },
    } as unknown as OpenClawConfig;

    const resolved = resolveSandboxToolPolicyForAgent(cfg, undefined);
    expect(resolved.allow).toEqual(["read"]);
    expect(resolved.deny).toEqual(["image"]);
  });
});

describe("isToolAllowedByPolicyName — apply_patch / write deny decoupling (#76749)", () => {
  it("does not deny apply_patch when write is denied", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { deny: ["write"] })).toBe(true);
  });

  it("still denies apply_patch when apply_patch is explicitly denied", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { deny: ["apply_patch"] })).toBe(false);
  });

  it("still allows apply_patch via write in the allow list", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { allow: ["write"], deny: [] })).toBe(true);
  });

  it("denies apply_patch when both write and apply_patch are denied", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { deny: ["write", "apply_patch"] })).toBe(
      false,
    );
  });
});

describe("cron family alias expansion (WOR-317)", () => {
  const CRON_FAMILY = [
    "cron",
    "cron_status",
    "cron_list",
    "cron_get",
    "cron_add",
    "cron_update",
    "cron_remove",
    "cron_run",
    "cron_runs",
    "cron_wake",
  ] as const;

  // The matcher feeds expandToolGroups output into compileGlobPatterns, so
  // a literal "cron" entry must expand to ["cron", "cron_*"] and cover every
  // per-action tool name at the deny/allow site. Each test below stands in
  // for a different policy path (global, per-agent, group, sender, sandbox,
  // inherited) — they all share this matcher.
  it("expandToolGroups expands a bare cron entry to the family glob", () => {
    const expanded = expandToolGroups(["cron"]);
    expect(expanded).toContain("cron");
    expect(expanded).toContain("cron_*");
  });

  it("expandToolGroups deduplicates when cron and an explicit cron_* glob are both present", () => {
    const expanded = expandToolGroups(["cron", "cron_*", "cron_update"]);
    expect(expanded.filter((entry) => entry === "cron_*")).toHaveLength(1);
    expect(expanded).toContain("cron");
    expect(expanded).toContain("cron_update");
  });

  it("global-style deny of cron blocks every per-action cron tool", () => {
    for (const tool of CRON_FAMILY) {
      expect(isToolAllowedByPolicyName(tool, { deny: ["cron"] })).toBe(false);
    }
  });

  it("global-style allow of cron permits every per-action cron tool", () => {
    for (const tool of CRON_FAMILY) {
      expect(isToolAllowedByPolicyName(tool, { allow: ["cron"] })).toBe(true);
    }
  });

  it("per-agent-style mixed allow includes cron family without breaking siblings", () => {
    // Simulates an agents.list[X].tools policy that allows cron plus a
    // sibling tool. The cron family is permitted, the sibling is permitted,
    // and unrelated tools (e.g. exec) are denied by the implicit allowlist.
    const policy = { allow: ["cron", "read"] };
    for (const tool of CRON_FAMILY) {
      expect(isToolAllowedByPolicyName(tool, policy)).toBe(true);
    }
    expect(isToolAllowedByPolicyName("read", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("exec", policy)).toBe(false);
  });

  it("sandbox-style allow including cron keeps legitimate cron callers working", () => {
    // SandboxToolPolicy uses the same matcher. An explicit allowlist that
    // names cron must keep cron_add / cron_update / etc usable.
    const policy: SandboxToolPolicy = { allow: ["cron", "read"], deny: [] };
    for (const tool of CRON_FAMILY) {
      expect(isToolAllowed(policy, tool)).toBe(true);
    }
    expect(isToolAllowed(policy, "read")).toBe(true);
  });

  it("deny overrides allow even when allow names the family", () => {
    const policy = { allow: ["*"], deny: ["cron"] };
    for (const tool of CRON_FAMILY) {
      expect(isToolAllowedByPolicyName(tool, policy)).toBe(false);
    }
  });

  it("a specific cron_* deny does not bleed into siblings outside the family", () => {
    // Denying the family must not deny apply_patch, read, or other tools.
    const policy = { deny: ["cron"] };
    expect(isToolAllowedByPolicyName("apply_patch", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("read", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("exec", policy)).toBe(true);
  });
});
