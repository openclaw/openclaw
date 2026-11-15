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

  it("keeps allowlist when it mixes plugin and core entries", () => {
    const input = { allow: ["lobster", "read"] };
    const policy = analyzeAllowlistByToolType(input, pluginGroups, coreTools);
    expect(input).toEqual({ allow: ["lobster", "read"] });
    expect(policy.unknownAllowlist).toStrictEqual([]);
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
