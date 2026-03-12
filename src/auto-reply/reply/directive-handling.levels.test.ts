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

  it("uses reasoningDefault from agentCfg when no session value", async () => {
    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentCfg: { reasoningDefault: "on" },
      resolveDefaultThinkingLevel: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.currentReasoningLevel).toBe("on");
  });

  it("session reasoningLevel overrides agentCfg reasoningDefault", async () => {
    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: { reasoningLevel: "stream" },
      agentCfg: { reasoningDefault: "off" },
      resolveDefaultThinkingLevel: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.currentReasoningLevel).toBe("stream");
  });

  it("defaults reasoning to off when no session or config value", async () => {
    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentCfg: {},
      resolveDefaultThinkingLevel: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.currentReasoningLevel).toBe("off");
  });
});
