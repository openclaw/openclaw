import { describe, expect, it } from "vitest";
import { findUndeclaredPluginToolNames } from "./tool-contracts.js";

describe("plugin tool contracts", () => {
  it("allows explicit prefix wildcard contracts for config-derived tool names", () => {
    expect(
      findUndeclaredPluginToolNames({
        declaredNames: ["derived_tool_*"],
        toolNames: ["derived_tool_calendar", "derived_tool_slack"],
      }),
    ).toEqual([]);
    expect(
      findUndeclaredPluginToolNames({
        declaredNames: ["derived_tool_*"],
        toolNames: ["memory_search"],
      }),
    ).toEqual(["memory_search"]);
  });
});
