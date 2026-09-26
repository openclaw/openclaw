// Tests directive verbosity levels and reply mode selection.
import { describe, expect, it, vi } from "vitest";
import { resolveCurrentDirectiveLevels } from "./directive-handling.levels.js";

describe("resolveCurrentDirectiveLevels", () => {
  it("prefers resolved model default over agent thinkingDefault", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("high");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentCfg: {
        thinkingDefault: "low",
      },
      resolveDefaultThinkingLevel,
    });

    expect(result.currentThinkLevel).toBe("high");
    expect(resolveDefaultThinkingLevel).toHaveBeenCalledTimes(1);
  });

  it("keeps session thinking override without consulting defaults", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("high");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {
        thinkingLevel: "minimal",
      },
      agentCfg: {
        thinkingDefault: "low",
      },
      resolveDefaultThinkingLevel,
    });

    expect(result.currentThinkLevel).toBe("minimal");
    expect(resolveDefaultThinkingLevel).not.toHaveBeenCalled();
  });

  it.each([
    { name: "session override", sessionEntry: { fastMode: true }, fastModeDefault: false },
    { name: "agent default", sessionEntry: {}, fastModeDefault: true },
  ])("resolves fast mode from $name", async ({ sessionEntry, fastModeDefault }) => {
    const result = await resolveCurrentDirectiveLevels({
      sessionEntry,
      agentEntry: { fastModeDefault },
      resolveDefaultThinkingLevel: async () => "low",
    });
    expect(result.currentFastMode).toBe(true);
  });

  it.each([
    ["session override", { reasoningLevel: "on" }, { reasoningDefault: "off" }, undefined, "on"],
    ["agent default", {}, { reasoningDefault: "stream" }, undefined, "stream"],
    ["global default", {}, undefined, { reasoningDefault: "stream" }, "stream"],
    ["built-in default", {}, {}, undefined, "off"],
  ] as const)(
    "resolves reasoning from %s independently of thinking",
    async (_name, sessionEntry, agentEntry, agentCfg, expected) => {
      const result = await resolveCurrentDirectiveLevels({
        sessionEntry,
        agentEntry,
        agentCfg,
        resolveDefaultThinkingLevel: async () => "high",
      });
      expect(result.currentThinkLevel).toBe("high");
      expect(result.currentReasoningLevel).toBe(expected);
    },
  );
});
