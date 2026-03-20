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

  it("uses config reasoningDefault when session reasoning is unset", async () => {
    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentCfg: {
        reasoningDefault: "stream",
      },
      resolveDefaultThinkingLevel: vi.fn().mockResolvedValue("off"),
    });

    expect(result.currentReasoningLevel).toBe("stream");
  });

  it("keeps session reasoning override over config reasoningDefault", async () => {
    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {
        reasoningLevel: "on",
      },
      agentCfg: {
        reasoningDefault: "stream",
      },
      resolveDefaultThinkingLevel: vi.fn().mockResolvedValue("off"),
    });

    expect(result.currentReasoningLevel).toBe("on");
  });
});
