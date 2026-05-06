import { describe, expect, it } from "vitest";
import { findUndeclaredPluginToolNames } from "./tool-contracts.js";

describe("plugin tool contracts", () => {
  it("allows explicit prefix wildcard contracts for config-derived tool names", () => {
    expect(
      findUndeclaredPluginToolNames({
        declaredNames: ["codex_plugin_*"],
        toolNames: ["codex_plugin_google_calendar", "codex_plugin_slack"],
      }),
    ).toEqual([]);
    expect(
      findUndeclaredPluginToolNames({
        declaredNames: ["codex_plugin_*"],
        toolNames: ["memory_search"],
      }),
    ).toEqual(["memory_search"]);
  });
});
