import { describe, expect, it } from "vitest";
import { AUTOMATIONS_TOOL_NAME, isAutomationsToolName } from "./automations-tool-name.js";

describe("isAutomationsToolName", () => {
  it("matches the canonical name and the cron alias", () => {
    expect(isAutomationsToolName(AUTOMATIONS_TOOL_NAME)).toBe(true);
    expect(isAutomationsToolName("cron")).toBe(true);
  });

  it("matches the MCP-exposed name mcp__<server>__<tool> (#193958)", () => {
    expect(isAutomationsToolName("mcp__openclaw__automations")).toBe(true);
    expect(isAutomationsToolName("mcp__openclaw__cron")).toBe(true);
  });

  it("does not match unrelated tools", () => {
    expect(isAutomationsToolName("read")).toBe(false);
    expect(isAutomationsToolName("mcp__openclaw__memory_search")).toBe(false);
  });
});
