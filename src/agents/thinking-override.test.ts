import { beforeEach, describe, expect, it, vi } from "vitest";

const hookRunnerMock = vi.fn();

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunnerMock(),
}));

import { resolveThinkingLevelOverride } from "./thinking-override.js";

const cfg = {
  agents: { defaults: { thinkingDefault: "low" } },
} as never;

describe("resolveThinkingLevelOverride", () => {
  beforeEach(() => {
    hookRunnerMock.mockReset();
  });

  it("preserves explicit > session > plugin > default precedence", async () => {
    hookRunnerMock.mockReturnValue({
      hasHooks: () => true,
      runBeforeModelResolve: vi.fn(async () => ({ thinkingLevelOverride: "medium" })),
    });

    await expect(
      resolveThinkingLevelOverride({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
        prompt: "debug this failing test",
        explicitOverride: "high",
        sessionOverride: "low",
      }),
    ).resolves.toBe("high");

    await expect(
      resolveThinkingLevelOverride({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
        prompt: "debug this failing test",
        sessionOverride: "low",
      }),
    ).resolves.toBe("low");

    await expect(
      resolveThinkingLevelOverride({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
        prompt: "debug this failing test",
      }),
    ).resolves.toBe("medium");
  });

  it("falls back to resolved default when plugin returns no override", async () => {
    hookRunnerMock.mockReturnValue({
      hasHooks: () => true,
      runBeforeModelResolve: vi.fn(async () => undefined),
    });

    await expect(
      resolveThinkingLevelOverride({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
        prompt: "hello",
      }),
    ).resolves.toBe("low");
  });

  it("passes run context into before_model_resolve hooks", async () => {
    const runBeforeModelResolve = vi.fn(async () => ({ thinkingLevelOverride: "medium" }));
    hookRunnerMock.mockReturnValue({
      hasHooks: () => true,
      runBeforeModelResolve,
    });

    await resolveThinkingLevelOverride({
      cfg,
      provider: "anthropic",
      model: "claude-opus-4-5",
      prompt: "debug this failing test",
      recentMessages: ["previous context"],
      attachmentCount: 1,
    });

    expect(runBeforeModelResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "debug this failing test",
        provider: "anthropic",
        model: "claude-opus-4-5",
        currentThinkingDefault: "low",
        recentMessages: ["previous context"],
        attachmentCount: 1,
      }),
      {},
    );
  });
});
