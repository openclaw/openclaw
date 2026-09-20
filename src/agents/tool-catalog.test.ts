/**
 * Regression coverage for core tool catalog profile defaults.
 * Verifies built-in profile allowlists include expected core tool groups.
 */
import { describe, expect, it } from "vitest";
import {
  listCoreToolSections,
  resolveCoreToolProfilePolicy,
  resolveCoreToolProfiles,
} from "./tool-catalog.js";
import { isToolAllowedByPolicies, isToolAllowedByPolicyName } from "./tool-policy-match.js";

function requireCoreToolProfilePolicy(profile: Parameters<typeof resolveCoreToolProfilePolicy>[0]) {
  const policy = resolveCoreToolProfilePolicy(profile);
  if (!policy) {
    throw new Error(`expected ${profile} tool profile policy`);
  }
  return policy;
}

function requirePolicyAllow(profile: Parameters<typeof resolveCoreToolProfilePolicy>[0]) {
  const allow = requireCoreToolProfilePolicy(profile).allow;
  if (!allow) {
    throw new Error(`expected ${profile} tool profile allow list`);
  }
  return allow;
}

describe("tool-catalog", () => {
  it("lists the setup helper once in Automation without adding restricted profile membership", () => {
    const sections = listCoreToolSections();
    expect(
      sections.flatMap((section) => section.tools).filter((tool) => tool.id === "openclaw"),
    ).toEqual([
      {
        id: "openclaw",
        label: "openclaw",
        description: "Delegate OpenClaw setup and repair",
      },
    ]);
    expect(
      sections.find((section) => section.id === "automation")?.tools.map((tool) => tool.id),
    ).toContain("openclaw");
    expect(resolveCoreToolProfiles("openclaw")).toEqual([]);
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

  it("lists agents_wait only for a Swarm-enabled catalog", () => {
    const ids = (config?: Parameters<typeof listCoreToolSections>[0]) =>
      listCoreToolSections(config).flatMap((section) => section.tools.map((tool) => tool.id));

    expect(ids()).not.toContain("agents_wait");
    expect(ids({ swarmEnabled: true })).toContain("agents_wait");
  });

  it("lists GitHub publication only with a prepared session capability", () => {
    const ids = (config?: Parameters<typeof listCoreToolSections>[0]) =>
      listCoreToolSections(config).flatMap((section) => section.tools.map((tool) => tool.id));

    expect(ids()).not.toContain("github_publish");
    expect(ids()).not.toContain("github_identity_status");
    expect(ids({ githubPublicationAvailable: false })).toContain("github_identity_status");
    expect(ids({ githubPublicationAvailable: true })).toContain("github_publish");
  });

  it("includes code execution, web tools, and progress_card in the coding profile policy", () => {
    const policy = requireCoreToolProfilePolicy("coding");
    expect(policy.allow).toEqual([
      "ls",
      "read",
      "write",
      "edit",
      "apply_patch",
      "exec",
      "process",
      "code_execution",
      "secrets",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
      "sessions",
      "sessions_list",
      "sessions_history",
      "sessions_search",
      "conversations_list",
      "conversations_send",
      "conversations_turn",
      "sessions_send",
      "sessions_spawn",
      "github_identity_status",
      "github_publish",
      "agents_wait",
      "sessions_yield",
      "subagents",
      "session_status",
      "suggest_task",
      "dismiss_task",
      "screen",
      "theme",
      "dashboard",
      "terminal",
      "portal",
      "automations",
      "gateway",
      "plugins",
      "get_goal",
      "create_goal",
      "update_goal",
      "progress_card",
      "ask_user",
      "skill_workshop",
      "view_image",
      "image_generate",
      "music_generate",
      "video_generate",
      "bundle-mcp",
    ]);
  });

  it("includes bundle MCP tools in coding and messaging profile policies", () => {
    expect(requirePolicyAllow("coding").at(-1)).toBe("bundle-mcp");
    expect(requirePolicyAllow("messaging")).toEqual([
      "secrets",
      "sessions",
      "sessions_list",
      "sessions_history",
      "sessions_search",
      "conversations_list",
      "conversations_send",
      "conversations_turn",
      "sessions_send",
      "sessions_spawn",
      "sessions_yield",
      "subagents",
      "session_status",
      "theme",
      "message",
      "gateway",
      "ask_user",
      "bundle-mcp",
    ]);
    expect(requirePolicyAllow("minimal")).toEqual(["session_status", "gateway"]);
  });

  it("treats pdf as a known media core tool, not a plugin id", () => {
    const mediaIds = listCoreToolSections()
      .find((section) => section.id === "media")
      ?.tools.map((tool) => tool.id);
    expect(mediaIds).toContain("pdf");
    expect(mediaIds).toContain("tts");
  });

  it("full profile uses wildcard to grant all tools (#76507)", () => {
    const policy = requireCoreToolProfilePolicy("full");
    expect(policy.allow).toEqual(["*"]);
  });
});
