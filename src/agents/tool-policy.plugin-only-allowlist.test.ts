import { describe, expect, it } from "vitest";

import { stripPluginOnlyAllowlist, type PluginToolGroups } from "./tool-policy.js";

const pluginGroups: PluginToolGroups = {
  all: ["lobster", "workflow_tool"],
  byPlugin: new Map([["lobster", ["lobster", "workflow_tool"]]]),
};

describe("stripPluginOnlyAllowlist", () => {
  it("strips allowlist when it only targets plugin tools", () => {
    const policy = stripPluginOnlyAllowlist({ allow: ["lobster"] }, pluginGroups);
    expect(policy?.allow).toBeUndefined();
  });

  it("strips allowlist when it only targets plugin groups", () => {
    const policy = stripPluginOnlyAllowlist({ allow: ["group:plugins"] }, pluginGroups);
    expect(policy?.allow).toBeUndefined();
  });

  it("keeps allowlist when it mixes plugin and core entries", () => {
    const policy = stripPluginOnlyAllowlist({ allow: ["lobster", "read"] }, pluginGroups);
    expect(policy?.allow).toEqual(["lobster", "read"]);
  });
});
