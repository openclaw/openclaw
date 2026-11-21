import { describe, expect, it } from "vitest";
import { AUTOMATIONS_TOOL_NAME, isAutomationsToolName } from "./automations-tool-name.js";

describe("isAutomationsToolName", () => {
  it.each([
    [AUTOMATIONS_TOOL_NAME, true],
    ["cron", true],
    ["mcp__openclaw__automations", true],
    ["mcp__openclaw__memory_search", false],
  ])("classifies %s as %s (#193958)", (name, expected) => {
    expect(isAutomationsToolName(name)).toBe(expected);
  });
});
