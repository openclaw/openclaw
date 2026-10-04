/**
 * Regression coverage for plugin-only tool allowlist analysis.
 * Confirms plugin group expansion and unknown allowlist reporting.
 */
import { describe, expect, it } from "vitest";
import {
  analyzeAllowlistByToolType,
  buildPluginToolGroups,
  type PluginToolGroups,
} from "./tool-policy.js";

const pluginGroups: PluginToolGroups = {
  all: ["lobster", "workflow_tool"],
  byPlugin: new Map([["lobster", ["lobster", "workflow_tool"]]]),
};
const coreTools = new Set(["read", "write", "exec", "session_status"]);

describe("analyzeAllowlistByToolType", () => {
  it("preserves allowlist when it only targets plugin groups", () => {
    const input = { allow: ["group:plugins"] };
    const policy = analyzeAllowlistByToolType(input, pluginGroups, coreTools);
    expect(input).toEqual({ allow: ["group:plugins"] });
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it('keeps allowlist when it uses "*"', () => {
    const input = { allow: ["*"] };
    const policy = analyzeAllowlistByToolType(input, pluginGroups, coreTools);
    expect(input).toEqual({ allow: ["*"] });
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it("keeps allowlist when it mixes plugin and core entries", () => {
    const input = { allow: ["lobster", "read"] };
    const policy = analyzeAllowlistByToolType(input, pluginGroups, coreTools);
    expect(input).toEqual({ allow: ["lobster", "read"] });
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it("keeps allowlist with core tools and reports unknown entries", () => {
    const emptyPlugins: PluginToolGroups = { all: [], byPlugin: new Map() };
    const input = { allow: ["read", "lobster"] };
    const policy = analyzeAllowlistByToolType(input, emptyPlugins, coreTools);
    expect(input).toEqual({ allow: ["read", "lobster"] });
    expect(policy.unknownAllowlist).toEqual(["lobster"]);
  });

  it("reports unavailable core entries as unknown", () => {
    const policy = analyzeAllowlistByToolType({ allow: ["apply_patch"] }, pluginGroups, coreTools);
    expect(policy.unknownAllowlist).toEqual(["apply_patch"]);
  });

  it("recognizes declared plugin tools before they are materialized", () => {
    const emptyPlugins: PluginToolGroups = { all: [], byPlugin: new Map() };
    const input = { allow: ["llm-task"] };
    const policy = analyzeAllowlistByToolType(input, emptyPlugins, coreTools, {
      pluginToolNames: ["llm-task"],
    });
    expect(input).toEqual({ allow: ["llm-task"] });
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it("recognizes declared MCP server namespace allowlists before tools are materialized", () => {
    const emptyPlugins: PluginToolGroups = { all: [], byPlugin: new Map() };
    const policy = analyzeAllowlistByToolType(
      { allow: ["paperless__*", "home-assistant__search"] },
      emptyPlugins,
      coreTools,
      { mcpServerNames: ["paperless", "Home Assistant"] },
    );
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it("still reports undeclared MCP namespace allowlist typos", () => {
    const emptyPlugins: PluginToolGroups = { all: [], byPlugin: new Map() };
    const policy = analyzeAllowlistByToolType(
      { allow: ["papreless__*"] },
      emptyPlugins,
      coreTools,
      { mcpServerNames: ["paperless"] },
    );
    expect(policy.unknownAllowlist).toStrictEqual(["papreless__*"]);
  });

  it("recognizes a core group shorthand when its members ship via a bundled plugin", () => {
    const bundledPluginGroups: PluginToolGroups = {
      all: ["web_search", "web_fetch"],
      byPlugin: new Map([["web", ["web_search", "web_fetch"]]]),
    };
    const noCoreWebTools = new Set(["read", "write", "exec"]);
    const input = { allow: ["group:web"] };
    const policy = analyzeAllowlistByToolType(input, bundledPluginGroups, noCoreWebTools);
    expect(input).toEqual({ allow: ["group:web"] });
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it("recognizes a core group shorthand when some members are core and some ship via a plugin", () => {
    const mixedGroups: PluginToolGroups = {
      all: ["x_search"],
      byPlugin: new Map([["x", ["x_search"]]]),
    };
    const partialCore = new Set(["web_search", "web_fetch"]);
    const input = { allow: ["group:web"] };
    const policy = analyzeAllowlistByToolType(input, mixedGroups, partialCore);
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it("still reports a core group shorthand when no member tool is available", () => {
    const emptyGroups: PluginToolGroups = { all: [], byPlugin: new Map() };
    const noMembers = new Set(["read", "write", "exec"]);
    const policy = analyzeAllowlistByToolType({ allow: ["group:web"] }, emptyGroups, noMembers);
    expect(policy.unknownAllowlist).toEqual(["group:web"]);
  });

  it("still reports an unknown group typo that matches no core or plugin group", () => {
    const policy = analyzeAllowlistByToolType({ allow: ["group:webs"] }, pluginGroups, coreTools);
    expect(policy.unknownAllowlist).toEqual(["group:webs"]);
  });

  it("ignores empty plugin ids when building groups", () => {
    const groups = buildPluginToolGroups({
      tools: [{ name: "lobster" }],
      toolMeta: () => ({ pluginId: "" }),
    });
    expect(groups.all).toEqual(["lobster"]);
    expect(groups.byPlugin.size).toBe(0);
  });
});
