/**
 * Regression coverage for core tool catalog profile defaults.
 * Verifies built-in profile allowlists include expected core tool groups.
 */
import { describe, expect, it } from "vitest";
import { resolveCoreToolProfilePolicy } from "./tool-catalog.js";

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
  it("includes code_execution, web_search, x_search, web_fetch, and update_plan in the coding profile policy", () => {
    const policy = requireCoreToolProfilePolicy("coding");
    expect(policy.allow).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
      "exec",
      "process",
      "runtime",
      "code_execution",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
      "sessions_list",
      "sessions_history",
      "sessions_send",
      "sessions_spawn",
      "sessions_yield",
      "subagents",
      "session_status",
      "cron",
      "get_goal",
      "create_goal",
      "update_goal",
      "update_plan",
      "skill_workshop",
      "image",
      "image_generate",
      "music_generate",
      "video_generate",
      "bundle-mcp",
    ]);
  });

  it("includes bundle MCP tools in coding and messaging profile policies", () => {
    expect(requirePolicyAllow("coding").at(-1)).toBe("bundle-mcp");
    expect(requirePolicyAllow("messaging")).toEqual([
      "sessions_list",
      "sessions_history",
      "sessions_send",
      "session_status",
      "message",
      "bundle-mcp",
    ]);
    expect(requirePolicyAllow("minimal")).toEqual(["session_status"]);
  });

  it("registers runtime in coding, runtime, and openclaw core policy surfaces", async () => {
    const { CORE_TOOL_GROUPS, resolveCoreToolProfiles, isKnownCoreToolId } =
      await import("./tool-catalog.js");

    expect(isKnownCoreToolId("runtime")).toBe(true);
    expect(resolveCoreToolProfiles("runtime")).toEqual(["coding"]);
    expect(CORE_TOOL_GROUPS["group:runtime"]).toContain("runtime");
    expect(CORE_TOOL_GROUPS["group:openclaw"]).toContain("runtime");
    expect(requirePolicyAllow("coding")).toContain("runtime");
  });

  it("full profile uses wildcard to grant all tools (#76507)", () => {
    const policy = requireCoreToolProfilePolicy("full");
    expect(policy.allow).toEqual(["*"]);
  });
});
