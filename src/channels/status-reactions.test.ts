import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveToolEmoji,
  createStatusReactionController,
  DEFAULT_EMOJIS,
  DEFAULT_TIMING,
  CODING_TOOL_TOKENS,
  WEB_TOOL_TOKENS,
  type StatusReactionAdapter,
} from "./status-reactions.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mock Adapter
// ─────────────────────────────────────────────────────────────────────────────

const createMockAdapter = () => {
  const calls: { method: string; emoji: string }[] = [];
  return {
    adapter: {
      setReaction: vi.fn(async (emoji: string) => {
        calls.push({ method: "set", emoji });
      }),
      removeReaction: vi.fn(async (emoji: string) => {
        calls.push({ method: "remove", emoji });
      }),
    } as StatusReactionAdapter,
    calls,
  };
};

const createEnabledController = (
  overrides: Partial<Parameters<typeof createStatusReactionController>[0]> = {},
) => {
  const { adapter, calls } = createMockAdapter();
  const controller = createStatusReactionController({
    enabled: true,
    adapter,
    initialEmoji: "👀",
    ...overrides,
  });
  return { adapter, calls, controller };
};

const createSetOnlyController = () => {
  const calls: { method: string; emoji: string }[] = [];
  const adapter: StatusReactionAdapter = {
    setReaction: vi.fn(async (emoji: string) => {
      calls.push({ method: "set", emoji });
    }),
  };
  const controller = createStatusReactionController({
    enabled: true,
    adapter,
    initialEmoji: "👀",
  });
  return { calls, controller };
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveToolEmoji", () => {
  const cases: Array<{
    name: string;
    tool: string | undefined;
    expected: string;
  }> = [
    { name: "returns coding emoji for exec tool", tool: "exec", expected: DEFAULT_EMOJIS.coding },
    {
      name: "returns coding emoji for process tool",
      tool: "process",
      expected: DEFAULT_EMOJIS.coding,
    },
    {
      name: "returns web emoji for web_search tool",
      tool: "web_search",
      expected: DEFAULT_EMOJIS.web,
    },
    { name: "returns web emoji for browser tool", tool: "browser", expected: DEFAULT_EMOJIS.web },
    {
      name: "returns tool emoji for unknown tool",
      tool: "unknown_tool",
      expected: DEFAULT_EMOJIS.tool,
    },
    { name: "returns tool emoji for empty string", tool: "", expected: DEFAULT_EMOJIS.tool },
    { name: "returns tool emoji for undefined", tool: undefined, expected: DEFAULT_EMOJIS.tool },
    { name: "is case-insensitive", tool: "EXEC", expected: DEFAULT_EMOJIS.coding },
    {
      name: "matches tokens within tool names",
      tool: "my_exec_wrapper",
      expected: DEFAULT_EMOJIS.coding,
    },
  ];

  for (const testCase of cases) {
    it(`should ${testCase.name}`, () => {
      expect(resolveToolEmoji(testCase.tool, DEFAULT_EMOJIS)).toBe(testCase.expected);
    });
  }
});

describe("createStatusReactionController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("should not call adapter when disabled", async () => {
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: false,
      adapter,
      initialEmoji: "👀",
    });

    void controller.setQueued();
    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(1000);

    expect(calls).toHaveLength(0);
  });

  it("should call setReaction with initialEmoji for setQueued immediately", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setQueued();
    await vi.runAllTimersAsync();

    expect(calls).toContainEqual({ method: "set", emoji: "👀" });
  });

  it("should debounce setThinking and eventually call adapter", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setThinking();

    // Before debounce period
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(0);

    // After debounce period
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toContainEqual({ method: "set", emoji: DEFAULT_EMOJIS.thinking });
  });

  it("should classify tool name and debounce", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setTool("exec");
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    expect(calls).toContainEqual({ method: "set", emoji: DEFAULT_EMOJIS.coding });
  });

  const immediateTerminalCases = [
    {
      name: "setDone",
      run: (controller: ReturnType<typeof createStatusReactionController>) => controller.setDone(),
      expected: DEFAULT_EMOJIS.done,
    },
    {
      name: "setError",
      run: (controller: ReturnType<typeof createStatusReactionController>) => controller.setError(),
      expected: DEFAULT_EMOJIS.error,
    },
  ] as const;

  for (const testCase of immediateTerminalCases) {
    it(`should execute ${testCase.name} immediately without debounce`, async () => {
      const { calls, controller } = createEnabledController();

      await testCase.run(controller);
      await vi.runAllTimersAsync();

      expect(calls).toContainEqual({ method: "set", emoji: testCase.expected });
    });
  }

  const terminalIgnoreCases = [
    {
      name: "ignore setThinking after setDone (terminal state)",
      terminal: (controller: ReturnType<typeof createStatusReactionController>) =>
        controller.setDone(),
      followup: (controller: ReturnType<typeof createStatusReactionController>) => {
        void controller.setThinking();
      },
    },
    {
      name: "ignore setTool after setError (terminal state)",
      terminal: (controller: ReturnType<typeof createStatusReactionController>) =>
        controller.setError(),
      followup: (controller: ReturnType<typeof createStatusReactionController>) => {
        void controller.setTool("exec");
      },
    },
  ] as const;

  for (const testCase of terminalIgnoreCases) {
    it(`should ${testCase.name}`, async () => {
      const { calls, controller } = createEnabledController();

      await testCase.terminal(controller);
      const callsAfterTerminal = calls.length;
      testCase.followup(controller);
      await vi.advanceTimersByTimeAsync(1000);

      expect(calls.length).toBe(callsAfterTerminal);
    });
  }

  it("should only fire last state when rapidly changing (debounce)", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(100);

    void controller.setTool("web_search");
    await vi.advanceTimersByTimeAsync(100);

    void controller.setTool("exec");
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    // Should only have the last one (exec → coding)
    const setEmojis = calls.filter((c) => c.method === "set").map((c) => c.emoji);
    expect(setEmojis).toEqual([DEFAULT_EMOJIS.coding]);
  });

  it("should deduplicate same emoji calls", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    const callsAfterFirst = calls.length;

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    // Should not add another call
    expect(calls.length).toBe(callsAfterFirst);
  });

  it("should call removeReaction when adapter supports it and emoji changes", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setQueued();
    await vi.runAllTimersAsync();

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    // Should set thinking, then remove queued
    expect(calls).toContainEqual({ method: "set", emoji: DEFAULT_EMOJIS.thinking });
    expect(calls).toContainEqual({ method: "remove", emoji: "👀" });
  });

  it("should only call setReaction when adapter lacks removeReaction", async () => {
    const { calls, controller } = createSetOnlyController();

    void controller.setQueued();
    await vi.runAllTimersAsync();

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    // Should only have set calls, no remove
    const removeCalls = calls.filter((c) => c.method === "remove");
    expect(removeCalls).toHaveLength(0);
    expect(calls.filter((c) => c.method === "set").length).toBeGreaterThan(0);
  });

  it("should clear all known emojis when adapter supports removeReaction", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setQueued();
    await vi.runAllTimersAsync();

    await controller.clear();

    // Should have removed multiple emojis
    const removeCalls = calls.filter((c) => c.method === "remove");
    expect(removeCalls.length).toBeGreaterThan(0);
  });

  it("should handle clear gracefully when adapter lacks removeReaction", async () => {
    const { calls, controller } = createSetOnlyController();

    await controller.clear();

    // Should not throw, no remove calls
    const removeCalls = calls.filter((c) => c.method === "remove");
    expect(removeCalls).toHaveLength(0);
  });

  it("should restore initial emoji", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    await controller.restoreInitial();

    expect(calls).toContainEqual({ method: "set", emoji: "👀" });
  });

  it("should use custom emojis when provided", async () => {
    const { calls, controller } = createEnabledController({
      emojis: {
        thinking: "🤔",
        done: "🎉",
      },
    });

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    expect(calls).toContainEqual({ method: "set", emoji: "🤔" });

    await controller.setDone();
    await vi.runAllTimersAsync();
    expect(calls).toContainEqual({ method: "set", emoji: "🎉" });
  });

  it("should use custom timing when provided", async () => {
    const { calls, controller } = createEnabledController({
      timing: {
        debounceMs: 100,
      },
    });

    void controller.setThinking();

    // Should not fire at 50ms
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toHaveLength(0);

    // Should fire at 100ms
    await vi.advanceTimersByTimeAsync(60);
    expect(calls).toContainEqual({ method: "set", emoji: DEFAULT_EMOJIS.thinking });
  });

  const stallCases = [
    {
      name: "soft stall timer after stallSoftMs",
      delayMs: DEFAULT_TIMING.stallSoftMs,
      expected: DEFAULT_EMOJIS.stallSoft,
    },
    {
      name: "hard stall timer after stallHardMs",
      delayMs: DEFAULT_TIMING.stallHardMs,
      expected: DEFAULT_EMOJIS.stallHard,
    },
  ] as const;

  const createControllerAfterThinking = async () => {
    const state = createEnabledController();
    void state.controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
    return state;
  };

  for (const testCase of stallCases) {
    it(`should trigger ${testCase.name}`, async () => {
      const { calls } = await createControllerAfterThinking();
      await vi.advanceTimersByTimeAsync(testCase.delayMs);

      expect(calls).toContainEqual({ method: "set", emoji: testCase.expected });
    });
  }

  const stallResetCases = [
    {
      name: "phase change",
      runUpdate: (controller: ReturnType<typeof createStatusReactionController>) => {
        void controller.setTool("exec");
        return vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
      },
    },
    {
      name: "repeated same-phase updates",
      runUpdate: (controller: ReturnType<typeof createStatusReactionController>) => {
        void controller.setThinking();
        return Promise.resolve();
      },
    },
  ] as const;

  for (const testCase of stallResetCases) {
    it(`should reset stall timers on ${testCase.name}`, async () => {
      const { calls, controller } = await createControllerAfterThinking();

      // Advance halfway to soft stall.
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallSoftMs / 2);

      await testCase.runUpdate(controller);

      // Advance another halfway - should not trigger stall yet.
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallSoftMs / 2);

      const stallCalls = calls.filter((c) => c.emoji === DEFAULT_EMOJIS.stallSoft);
      expect(stallCalls).toHaveLength(0);
    });
  }

  it("should call onError callback when adapter throws", async () => {
    const onError = vi.fn();
    const adapter: StatusReactionAdapter = {
      setReaction: vi.fn(async () => {
        throw new Error("Network error");
      }),
    };

    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
      onError,
    });

    void controller.setQueued();
    await vi.runAllTimersAsync();

    expect(onError).toHaveBeenCalled();
  });
});

describe("constants", () => {
  it("should export CODING_TOOL_TOKENS", () => {
    for (const token of ["exec", "read", "write"]) {
      expect(CODING_TOOL_TOKENS).toContain(token);
    }
  });

  it("should export WEB_TOOL_TOKENS", () => {
    for (const token of ["web_search", "browser"]) {
      expect(WEB_TOOL_TOKENS).toContain(token);
    }
  });

  it("should export DEFAULT_EMOJIS with all required keys", () => {
    const emojiKeys = [
      "queued",
      "thinking",
      "tool",
      "coding",
      "web",
      "done",
      "error",
      "stallSoft",
      "stallHard",
    ] as const;
    for (const key of emojiKeys) {
      expect(DEFAULT_EMOJIS).toHaveProperty(key);
    }
  });

  it("should export DEFAULT_TIMING with all required keys", () => {
    for (const key of ["debounceMs", "stallSoftMs", "stallHardMs", "doneHoldMs", "errorHoldMs"]) {
      expect(DEFAULT_TIMING).toHaveProperty(key);
    }
  });
});
