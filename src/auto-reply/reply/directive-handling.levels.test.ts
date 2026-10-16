import { describe, expect, it, vi } from "vitest";
import { resolveCurrentDirectiveLevels } from "./directive-handling.levels.js";

describe("resolveCurrentDirectiveLevels", () => {
  it.each([
    {
      name: "model thinking default",
      sessionEntry: {},
      agentCfg: { thinkingDefault: "low" },
      expected: { currentThinkLevel: "high" },
      defaultCalls: 1,
    },
    {
      name: "session thinking override",
      sessionEntry: { thinkingLevel: "minimal" },
      agentCfg: { thinkingDefault: "low" },
      expected: { currentThinkLevel: "minimal" },
      defaultCalls: 0,
    },
    {
      name: "session fast override",
      sessionEntry: { fastMode: false },
      agentEntry: { fastModeDefault: true },
      expected: { currentFastMode: false },
      defaultCalls: 1,
    },
    {
      name: "agent fast default",
      sessionEntry: {},
      agentEntry: { fastModeDefault: true },
      expected: { currentFastMode: true },
      defaultCalls: 1,
    },
    {
      name: "session reasoning override",
      sessionEntry: { reasoningLevel: "on" },
      agentEntry: { reasoningDefault: "off" },
      expected: { currentReasoningLevel: "on" },
      defaultCalls: 1,
    },
    {
      name: "agent reasoning default",
      sessionEntry: {},
      agentEntry: { reasoningDefault: "stream" },
      expected: { currentReasoningLevel: "stream" },
      defaultCalls: 1,
    },
    {
      name: "config reasoning default",
      sessionEntry: {},
      agentCfg: { reasoningDefault: "stream" },
      expected: { currentReasoningLevel: "stream" },
      defaultCalls: 1,
    },
  ])("resolves $name", async ({ sessionEntry, agentCfg, agentEntry, expected, defaultCalls }) => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("high");
    const result = await resolveCurrentDirectiveLevels({
      sessionEntry,
      agentCfg,
      agentEntry,
      resolveDefaultThinkingLevel,
    });
    expect(result).toMatchObject(expected);
    expect(resolveDefaultThinkingLevel).toHaveBeenCalledTimes(defaultCalls);
  });
});
