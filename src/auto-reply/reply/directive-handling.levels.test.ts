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

  it("prefers session fastMode over agent default", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("low");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {
        fastMode: true,
      },
      agentEntry: {
        fastModeDefault: false,
      },
      resolveDefaultThinkingLevel,
    });

    expect(result.currentFastMode).toBe(true);
  });

  it("falls back to agent fastModeDefault when session override is absent", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("low");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentEntry: {
        fastModeDefault: true,
      },
      resolveDefaultThinkingLevel,
    });

    expect(result.currentFastMode).toBe(true);
  });

  it("prefers session reasoningLevel over agent default", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("low");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {
        reasoningLevel: "on",
      },
      agentEntry: {
        reasoningDefault: "off",
      },
      resolveDefaultThinkingLevel,
    });

    expect(result.currentReasoningLevel).toBe("on");
  });

  it("falls back to agent reasoningDefault when session override is absent", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("off");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentEntry: {
        reasoningDefault: "stream",
      },
      resolveDefaultThinkingLevel,
    });

    expect(result.currentReasoningLevel).toBe("stream");
  });

  it("skips agent reasoningDefault when thinking is active", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("low");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentEntry: {
        reasoningDefault: "stream",
      },
      resolveDefaultThinkingLevel,
    });

    expect(result.currentReasoningLevel).toBe("off");
  });
});
