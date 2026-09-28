import { describe, expect, it } from "vitest";
import { createCronTool } from "./cron-tool.js";

describe("cron tool timezone guidance", () => {
  it("keeps cron expressions in local wall-clock time for tz", () => {
    const tool = createCronTool(undefined, {
      callGatewayTool: async <T = Record<string, unknown>>() => undefined as T,
    });

    expect(tool.description).toContain("expr is wall time in tz");
    expect(tool.description).toContain("never pre-convert to UTC");
    expect(tool.description).toContain("no tz=gateway host local");
    expect(tool.description).toContain("no tz=UTC");
    expect(tool.description).toContain('expr:"0 18 * * *"');
    expect(tool.description).toContain('tz:"Asia/Shanghai"');
  });
});
