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

function requireCoreToolProfilePolicy(profile: Parameters<typeof resolveCoreToolProfilePolicy>[0]) {
  const policy = resolveCoreToolProfilePolicy(profile);
  if (!policy) {
    throw new Error(`expected ${profile} tool profile policy`);
  }
  return policy;
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

  it.each(["group:automation", "group:openclaw"])(
    "includes the helper in %s allows and denies",
    (group) => {
      expect(isToolAllowedByPolicyName("openclaw", { allow: [group] })).toBe(true);
      expect(isToolAllowedByPolicyName("openclaw", { allow: [group], deny: ["openclaw"] })).toBe(
        false,
      );
      expect(isToolAllowedByPolicyName("openclaw", { allow: ["openclaw"], deny: [group] })).toBe(
        false,
      );
      for (const profile of [undefined, "full"]) {
        const policy = resolveCoreToolProfilePolicy(profile);
        expect(isToolAllowedByPolicies("openclaw", [policy])).toBe(true);
        expect(isToolAllowedByPolicies("message", [policy])).toBe(true);
        expect(isToolAllowedByPolicies("openclaw", [policy, { deny: [group] }])).toBe(false);
        expect(isToolAllowedByPolicies("exec", [policy, { deny: ["exec"] }])).toBe(false);
      }
    },
  );

  it("lets operators configure run-dependent tools without granting restricted profiles", () => {
    const ids = listCoreToolSections().flatMap((section) => section.tools.map((tool) => tool.id));
    expect(ids).toEqual(
      expect.arrayContaining(["github_publish", "github_identity_status", "transcripts"]),
    );
    expect(resolveCoreToolProfiles("transcripts")).toEqual([]);
  });

  it.each(["group:media", "group:openclaw"])(
    "preserves saved %s grants and denies when listing transcripts",
    (group) => {
      const tools = [{ name: "transcripts" }, { name: "pdf" }];
      expect(filterToolsByPolicy(tools, { allow: [group] })).toEqual([{ name: "pdf" }]);
      expect(filterToolsByPolicy(tools, { allow: ["*"], deny: [group] })).toEqual([
        { name: "transcripts" },
      ]);
      expect(filterToolsByPolicy(tools, { allow: ["transcripts"], deny: [group] })).toEqual([
        { name: "transcripts" },
      ]);
      expect(filterToolsByPolicy(tools, { allow: ["*"], deny: ["transcripts"] })).toEqual([
        { name: "pdf" },
      ]);
    },
  );

  it.each([
    {
      profile: "minimal",
      allowed: ["presence", "session_status", "gateway"],
      denied: ["exec", "message"],
    },
    { profile: "coding", allowed: ["read", "exec", "bundle-mcp"], denied: ["browser", "message"] },
    {
      profile: "messaging",
      allowed: ["message", "bundle-mcp"],
      denied: ["exec", "process", "write"],
    },
  ] as const)("keeps the $profile capability boundary", ({ profile, allowed, denied }) => {
    const policy = requireCoreToolProfilePolicy(profile);
    if (profile === "minimal") {
      expect(policy.allow).toEqual(["presence", "session_status", "gateway"]);
    }
    for (const tool of allowed) {
      expect(isToolAllowedByPolicies(tool, [policy]), tool).toBe(true);
    }
    for (const tool of [...denied, "tts", "openclaw"]) {
      expect(isToolAllowedByPolicies(tool, [policy]), tool).toBe(false);
    }
  });

  it("full profile uses wildcard to grant all tools (#76507)", () => {
    const policy = requireCoreToolProfilePolicy("full");
    expect(policy.allow).toEqual(["*"]);
  });
});
