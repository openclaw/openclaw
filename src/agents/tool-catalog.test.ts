import { describe, expect, it } from "vitest";
import {
  listCoreToolSections,
  resolveCoreToolProfilePolicy,
  resolveCoreToolProfiles,
} from "./tool-catalog.js";
import {
  filterToolsByPolicy,
  isToolAllowedByPolicies,
  isToolAllowedByPolicyName,
} from "./tool-policy-match.js";

function expectAccess(
  tool: string,
  policies: Parameters<typeof isToolAllowedByPolicies>[1],
  allowed = true,
) {
  expect(isToolAllowedByPolicies(tool, policies), tool).toBe(allowed);
}

describe("tool-catalog", () => {
  it.each([
    ["personal_instructions", { personalInstructionsEnabled: true }],
    ["agents_wait", { swarmEnabled: true }],
  ] as const)("lists %s only with its capability enabled", (id, config) => {
    const ids = (options?: Parameters<typeof listCoreToolSections>[0]) =>
      listCoreToolSections(options).flatMap((section) => section.tools.map((tool) => tool.id));
    expect(ids()).not.toContain(id);
    expect(ids({ personalInstructionsEnabled: false })).not.toContain(id);
    expect(ids(config)).toContain(id);
  });

  it.each(["group:automation", "group:openclaw"])("respects %s helper policy", (group) => {
    expect(
      [
        { allow: [group] },
        { allow: [group], deny: ["openclaw"] },
        { allow: ["openclaw"], deny: [group] },
      ].map((policy) => isToolAllowedByPolicyName("openclaw", policy)),
    ).toEqual([true, false, false]);
    for (const profile of [undefined, "full"]) {
      const policy = resolveCoreToolProfilePolicy(profile);
      expectAccess("openclaw", [policy]);
      expectAccess("message", [policy]);
      expectAccess("openclaw", [policy, { deny: [group] }], false);
      expectAccess("exec", [policy, { deny: ["exec"] }], false);
    }
  });

  it("lets operators configure run-dependent tools without granting restricted profiles", () => {
    const ids = listCoreToolSections().flatMap((section) => section.tools.map((tool) => tool.id));
    expect(ids).toEqual(
      expect.arrayContaining(["github_publish", "github_identity_status", "transcripts"]),
    );
    expect(resolveCoreToolProfiles("transcripts")).toEqual([]);
  });

  it.each(["group:media", "group:openclaw"])("preserves saved %s transcript policy", (group) => {
    const transcript = { name: "transcripts" },
      pdf = { name: "pdf" };
    const tools = [{ ...transcript }, { ...pdf }];
    expect(filterToolsByPolicy(tools, { allow: [group] })).toEqual([pdf]);
    for (const allow of [["*"], ["transcripts"]]) {
      expect(filterToolsByPolicy(tools, { allow, deny: [group] })).toEqual([transcript]);
    }
    expect(filterToolsByPolicy(tools, { allow: ["*"], deny: ["transcripts"] })).toEqual([pdf]);
  });

  it.each([
    ["minimal", ["presence", "session_status", "gateway"], ["exec", "message", "sessions_create"]],
    ["coding", ["read", "exec", "bundle-mcp", "sessions_create"], ["browser", "message"]],
    ["messaging", ["message", "bundle-mcp", "sessions_create"], ["exec", "process", "write"]],
  ] as const)("keeps the %s capability boundary", (profile, allowed, denied) => {
    const policy = resolveCoreToolProfilePolicy(profile);
    if (profile === "minimal") {
      expect(policy?.allow).toEqual(["presence", "session_status", "gateway"]);
    }
    for (const tool of allowed) {
      expectAccess(tool, [policy]);
    }
    for (const tool of [...denied, "tts", "openclaw"]) {
      expectAccess(tool, [policy], false);
    }
  });

  it("full profile uses wildcard to grant all tools (#76507)", () => {
    expect(resolveCoreToolProfilePolicy("full")?.allow).toEqual(["*"]);
  });
});
