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

  it("applies surface verbose and reasoning defaults when session overrides are absent", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("low");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentCfg: {
        verboseDefault: "off",
        surfaceDefaults: {
          tui: {
            verboseDefault: "full",
            reasoningDefault: "on",
          },
        },
      },
      surface: "tui",
      provider: "webchat",
      resolveDefaultThinkingLevel,
    });

    expect(result.currentVerboseLevel).toBe("full");
    expect(result.currentReasoningLevel).toBe("on");
  });

  it("keeps session overrides above surface defaults", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("low");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {
        verboseLevel: "on",
        reasoningLevel: "stream",
      },
      agentCfg: {
        verboseDefault: "off",
        surfaceDefaults: {
          discord: {
            verboseDefault: "full",
            reasoningDefault: "off",
          },
        },
      },
      surface: "discord",
      resolveDefaultThinkingLevel,
    });

    expect(result.currentVerboseLevel).toBe("on");
    expect(result.currentReasoningLevel).toBe("stream");
  });
});
