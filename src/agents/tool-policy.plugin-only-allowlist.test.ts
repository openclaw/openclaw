/**
 * Regression coverage for plugin-only tool allowlist analysis.
 * Confirms plugin group expansion and unknown allowlist reporting.
 */
import { describe, expect, it } from "vitest";
import { applyToolPolicyPipeline } from "./tool-policy-pipeline.js";
import {
  analyzeAllowlistByToolType,
  buildPluginToolGroups,
  type PluginToolGroups,
  type ToolPolicyLike,
} from "./tool-policy.js";

const pluginGroups: PluginToolGroups = {
  all: ["lobster", "workflow_tool"],
  byPlugin: new Map([["lobster", ["lobster", "workflow_tool"]]]),
  allowByPlugin: new Map([["lobster", ["lobster", "workflow_tool"]]]),
};
const coreTools = new Set(["read", "write", "exec", "session_status"]);

describe("plugin owner policy", () => {
  it("uses only verified owners for plugin-ID allows and keeps all claims for denies", () => {
    const tools = [
      { name: "fixture_verified", owner: { pluginId: "fixture-owner" } },
      { name: "fixture_unverified", owner: { pluginId: "fixture-owner", ownerUnverified: true } },
    ];
    const project = (policy: ToolPolicyLike) =>
      applyToolPolicyPipeline({
        tools,
        toolMeta: (tool) => tool.owner,
        warn: () => undefined,
        steps: [{ policy, label: "fixture tool policy" }],
      }).map((tool) => tool.name);

    expect(project({ allow: ["fixture-owner"] })).toEqual(["fixture_verified"]);
    expect(project({ deny: ["fixture-owner"] })).toEqual([]);
    expect(project({ allow: ["fixture_unverified"] })).toEqual(["fixture_unverified"]);
    expect(project({ allow: ["group:plugins"] })).toEqual([
      "fixture_verified",
      "fixture_unverified",
    ]);
  });
});

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
