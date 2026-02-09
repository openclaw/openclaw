import { describe, expect, it } from "vitest";
import { stripPluginOnlyAllowlist, type PluginToolGroups } from "./tool-policy.js";

const pluginGroups: PluginToolGroups = {
  all: ["lobster", "workflow_tool"],
  byPlugin: new Map([["lobster", ["lobster", "workflow_tool"]]]),
};
const coreTools = new Set(["read", "write", "exec", "session_status"]);

describe("stripPluginOnlyAllowlist", () => {
  it("strips allowlist when it only targets plugin tools", () => {
    const policy = stripPluginOnlyAllowlist({ allow: ["lobster"] }, pluginGroups, coreTools);
    expect(policy.policy?.allow).toBeUndefined();
    expect(policy.unknownAllowlist).toEqual([]);
  });

  it("strips allowlist when it only targets plugin groups", () => {
    const policy = stripPluginOnlyAllowlist({ allow: ["group:plugins"] }, pluginGroups, coreTools);
    expect(policy.policy?.allow).toBeUndefined();
    expect(policy.unknownAllowlist).toEqual([]);
  });

  it('keeps allowlist when it uses "*"', () => {
    const policy = stripPluginOnlyAllowlist({ allow: ["*"] }, pluginGroups, coreTools);
    expect(policy.policy?.allow).toEqual(["*"]);
    expect(policy.unknownAllowlist).toEqual([]);
  });

  it("keeps allowlist when it mixes plugin and core entries", () => {
    const policy = stripPluginOnlyAllowlist(
      { allow: ["lobster", "read"] },
      pluginGroups,
      coreTools,
    );
    expect(policy.policy?.allow).toEqual(["lobster", "read"]);
    expect(policy.unknownAllowlist).toEqual([]);
  });

  it("strips allowlist with unknown entries when no core tools match", () => {
    const emptyPlugins: PluginToolGroups = { all: [], byPlugin: new Map() };
    const policy = stripPluginOnlyAllowlist({ allow: ["lobster"] }, emptyPlugins, coreTools);
    expect(policy.policy?.allow).toBeUndefined();
    expect(policy.unknownAllowlist).toEqual(["lobster"]);
  });

  it("keeps allowlist with core tools and reports unknown entries", () => {
    const emptyPlugins: PluginToolGroups = { all: [], byPlugin: new Map() };
    const policy = stripPluginOnlyAllowlist(
      { allow: ["read", "lobster"] },
      emptyPlugins,
      coreTools,
    );
    expect(policy.policy?.allow).toEqual(["read", "lobster"]);
    expect(policy.unknownAllowlist).toEqual(["lobster"]);
  });

  it("recognises tool groups that expand to plugin tools (group:memory)", () => {
    // memory_search and memory_get are provided by the memory-core plugin
    const memoryPlugins: PluginToolGroups = {
      all: ["memory_search", "memory_get"],
      byPlugin: new Map([["memory-core", ["memory_search", "memory_get"]]]),
    };
    const policy = stripPluginOnlyAllowlist(
      { allow: ["read", "group:memory"] },
      memoryPlugins,
      coreTools,
    );
    expect(policy.policy?.allow).toEqual(["read", "group:memory"]);
    expect(policy.unknownAllowlist).toEqual([]);
  });

  it("strips allowlist when group expands only to plugin tools and no core tools", () => {
    const memoryPlugins: PluginToolGroups = {
      all: ["memory_search", "memory_get"],
      byPlugin: new Map([["memory-core", ["memory_search", "memory_get"]]]),
    };
    const policy = stripPluginOnlyAllowlist({ allow: ["group:memory"] }, memoryPlugins, coreTools);
    expect(policy.policy?.allow).toBeUndefined();
    expect(policy.unknownAllowlist).toEqual([]);
  });

  it("does not flag group entries whose expansion maps to plugin tools as unknown", () => {
    // Regression test for #12643: group:memory was treated as unknown
    // even when memory_search/memory_get were registered plugin tools.
    const memoryPlugins: PluginToolGroups = {
      all: ["memory_search", "memory_get", "lobster"],
      byPlugin: new Map([
        ["memory-core", ["memory_search", "memory_get"]],
        ["lobster", ["lobster"]],
      ]),
    };
    const policy = stripPluginOnlyAllowlist(
      { allow: ["exec", "group:memory", "lobster"] },
      memoryPlugins,
      coreTools,
    );
    expect(policy.policy?.allow).toEqual(["exec", "group:memory", "lobster"]);
    expect(policy.unknownAllowlist).toEqual([]);
  });
});
