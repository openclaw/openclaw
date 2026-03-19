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

  // reasoningDefault tests
  it("uses agent reasoningDefault when session reasoningLevel is absent", async () => {
    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentCfg: {
        reasoningDefault: "on",
      },
      resolveDefaultThinkingLevel: vi.fn(),
    });

    expect(result.currentReasoningLevel).toBe("on");
  });

  it("session reasoningLevel overrides agent reasoningDefault", async () => {
    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {
        reasoningLevel: "off",
      },
      agentCfg: {
        reasoningDefault: "on",
      },
      resolveDefaultThinkingLevel: vi.fn(),
    });

    expect(result.currentReasoningLevel).toBe("off");
  });

  it("defaults reasoningLevel to off when neither session nor config is set", async () => {
    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentCfg: {},
      resolveDefaultThinkingLevel: vi.fn(),
    });

    expect(result.currentReasoningLevel).toBe("off");
  });
});
