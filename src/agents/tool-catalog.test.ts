import { describe, expect, it } from "vitest";
import { CORE_TOOL_GROUPS, resolveCoreToolProfilePolicy } from "./tool-catalog.js";

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

const CRON_PER_ACTION_TOOL_IDS = [
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
      "cron_status",
      "cron_list",
      "cron_get",
      "cron_add",
      "cron_update",
      "cron_remove",
      "cron_run",
      "cron_runs",
      "cron_wake",
      "update_plan",
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

  it("full profile uses wildcard to grant all tools (#76507)", () => {
    const policy = requireCoreToolProfilePolicy("full");
    expect(policy.allow).toEqual(["*"]);
  });

  // WOR-317: per-action cron tools must be first-class members of the coding
  // profile and the openclaw tool group. Without this, the default coding
  // profile filters them out of filterToolsByPolicy and users only see the
  // legacy super-tool.
  it("registers every cron_* per-action tool in the coding profile allowlist", () => {
    const allow = requirePolicyAllow("coding");
    for (const id of CRON_PER_ACTION_TOOL_IDS) {
      expect(allow).toContain(id);
    }
  });

  it("registers every cron_* per-action tool in the openclaw tool group", () => {
    const groups = CORE_TOOL_GROUPS as Record<string, string[] | undefined>;
    const openclawGroup = groups["group:openclaw"];
    expect(openclawGroup).toBeDefined();
    for (const id of CRON_PER_ACTION_TOOL_IDS) {
      expect(openclawGroup).toContain(id);
    }
  });

  it("registers every cron_* per-action tool in the automation section group", () => {
    const groups = CORE_TOOL_GROUPS as Record<string, string[] | undefined>;
    const automation = groups["group:automation"];
    expect(automation).toBeDefined();
    for (const id of CRON_PER_ACTION_TOOL_IDS) {
      expect(automation).toContain(id);
    }
  });
});
