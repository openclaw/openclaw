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

  it("uses reasoningDefault from agent config when session has no override", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue(undefined);

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentCfg: {
        reasoningDefault: "stream",
      },
      resolveDefaultThinkingLevel,
    });

    expect(result.currentReasoningLevel).toBe("stream");
  });

  it("prefers session reasoningLevel over reasoningDefault", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue(undefined);

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {
        reasoningLevel: "on",
      },
      agentCfg: {
        reasoningDefault: "stream",
      },
      resolveDefaultThinkingLevel,
    });

    expect(result.currentReasoningLevel).toBe("on");
  });

  it("defaults reasoning to off when no session or config override", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue(undefined);

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentCfg: {},
      resolveDefaultThinkingLevel,
    });

    expect(result.currentReasoningLevel).toBe("off");
  });
});
