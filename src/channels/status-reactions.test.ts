// Status reaction tests cover generic reaction selection and update behavior for channel replies.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveToolEmoji,
  createStatusReactionController,
  DEFAULT_EMOJIS,
  DEFAULT_TIMING,
  type StatusReactionAdapter,
} from "./status-reactions.js";

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

const createSingleSlotController = () => {
  const calls: { method: string; emoji: string }[] = [];
  const adapter: StatusReactionAdapter = {
    setReaction: vi.fn(async (emoji: string) => {
      calls.push({ method: "set", emoji });
    }),
    clearReaction: vi.fn(async () => {
      calls.push({ method: "clear", emoji: "" });
    }),
  };
  const controller = createStatusReactionController({
    enabled: true,
    adapter,
    initialEmoji: "👀",
  });
  return { calls, controller };
};

function expectSetEmojiCall(calls: Array<{ method: string; emoji: string }>, emoji: string) {
  expect(collectEmojisForMethod(calls, "set")).toContain(emoji);
}

function collectEmojisForMethod(
  calls: Array<{ method: string; emoji: string }>,
  method: string,
): string[] {
  const emojis: string[] = [];
  for (const call of calls) {
    if (call.method === method) {
      emojis.push(call.emoji);
    }
  }
  return emojis;
}

function countCallsForEmoji(calls: Array<{ method: string; emoji: string }>, emoji: string) {
  let count = 0;
  for (const call of calls) {
    if (call.emoji === emoji) {
      count += 1;
    }
  }
  return count;
}
describe("resolveToolEmoji", () => {
  it.each([
    {
      name: "returns tool emoji for unknown tool",
      tool: "unknown_tool",
      expected: DEFAULT_EMOJIS.tool,
    },
    { name: "returns tool emoji for undefined", tool: undefined, expected: DEFAULT_EMOJIS.tool },
  ] satisfies Array<{ name: string; tool: string | undefined; expected: string }>)(
    "should $name",
    ({ tool, expected }) => {
      expect(resolveToolEmoji(tool, DEFAULT_EMOJIS)).toBe(expected);
    },
  );

  it("preserves explicit status emoji overrides before exact tool display emojis", () => {
    const emojis = {
      ...DEFAULT_EMOJIS,
      coding: "🧪",
      web: "🛰️",
      tool: "🔧",
    };
    const overrides = {
      coding: "🧪",
      web: "🛰️",
      tool: "🔧",
    };

    expect(resolveToolEmoji("exec", emojis, overrides)).toBe("🧪");
    expect(resolveToolEmoji("read", emojis, overrides)).toBe("🧪");
    expect(resolveToolEmoji("write", emojis, overrides)).toBe("🧪");
    expect(resolveToolEmoji("web_search", emojis, overrides)).toBe("🛰️");
    expect(resolveToolEmoji("message", emojis, overrides)).toBe("🔧");
  });
});

describe("createStatusReactionController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const immediateTerminalCases = [
    {
      name: "setDone",
      run: (controller: ReturnType<typeof createStatusReactionController>) => controller.setDone(),
      expected: DEFAULT_EMOJIS.done,
      holdMs: DEFAULT_TIMING.doneHoldMs,
    },
    {
      name: "setError",
      run: (controller: ReturnType<typeof createStatusReactionController>) => controller.setError(),
      expected: DEFAULT_EMOJIS.error,
      holdMs: DEFAULT_TIMING.errorHoldMs,
    },
  ] as const;

  it.each(immediateTerminalCases)(
    "should hold $name before an immediately queued restore",
    async ({ run, expected, holdMs }) => {
      const { calls, controller } = createEnabledController();

      void controller.setQueued();
      await vi.advanceTimersByTimeAsync(0);

      let terminalResolved = false;
      let restoreResolved = false;
      const terminalPromise = run(controller).then(() => {
        terminalResolved = true;
      });
      const restorePromise = controller.restoreInitial().then(() => {
        restoreResolved = true;
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(calls).toEqual([
        { method: "set", emoji: "👀" },
        { method: "set", emoji: expected },
        { method: "remove", emoji: "👀" },
      ]);
      expect(terminalResolved).toBe(false);
      expect(restoreResolved).toBe(false);

      await vi.advanceTimersByTimeAsync(holdMs - 1);

      expect(collectEmojisForMethod(calls, "set")).toEqual(["👀", expected]);
      expect(terminalResolved).toBe(false);
      expect(restoreResolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([terminalPromise, restorePromise]);

      expect(calls).toEqual([
        { method: "set", emoji: "👀" },
        { method: "set", emoji: expected },
        { method: "remove", emoji: "👀" },
        { method: "set", emoji: "👀" },
        { method: "remove", emoji: expected },
      ]);
      expect(terminalResolved).toBe(true);
      expect(restoreResolved).toBe(true);
      expect(countCallsForEmoji(calls, expected)).toBe(2);
    },
  );

  it("should only fire last state when rapidly changing (debounce)", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(100);

    void controller.setTool("web_search");
    await vi.advanceTimersByTimeAsync(100);

    void controller.setTool("exec");
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    // Should only have the last one (exec → display emoji)
    const setEmojis = collectEmojisForMethod(calls, "set");
    expect(setEmojis).toEqual(["🛠️"]);
  });

  it("should cancel a pending compacting emoji before resuming thinking", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setCompacting();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs - 1);
    controller.cancelPending();
    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    const setEmojis = collectEmojisForMethod(calls, "set");
    expect(setEmojis).toEqual([DEFAULT_EMOJIS.thinking]);
  });

  it("uses clearReaction only for explicit clear on single-slot adapters", async () => {
    const { calls, controller } = createSingleSlotController();

    void controller.setQueued();
    await vi.runAllTimersAsync();
    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    const donePromise = controller.setDone();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.doneHoldMs);
    await donePromise;
    await controller.restoreInitial();

    expect(calls).toEqual([
      { method: "set", emoji: "👀" },
      { method: "set", emoji: DEFAULT_EMOJIS.stallSoft },
      { method: "set", emoji: DEFAULT_EMOJIS.stallHard },
      { method: "set", emoji: DEFAULT_EMOJIS.thinking },
      { method: "set", emoji: DEFAULT_EMOJIS.done },
      { method: "set", emoji: "👀" },
    ]);

    await controller.clear();
    expect(calls.at(-1)).toEqual({ method: "clear", emoji: "" });
  });

  it("should cancel a terminal hold when explicitly cleared", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setQueued();
    await vi.advanceTimersByTimeAsync(0);
    let terminalResolved = false;
    const terminalPromise = controller.setError().then(() => {
      terminalResolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expectSetEmojiCall(calls, DEFAULT_EMOJIS.error);
    expect(terminalResolved).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    const clearPromise = controller.clear();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([terminalPromise, clearPromise]);

    expect(terminalResolved).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(collectEmojisForMethod(calls, "remove")).toEqual(["👀", DEFAULT_EMOJIS.error]);
  });

  const createControllerAfterThinking = async () => {
    const state = createEnabledController();
    void state.controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
    return state;
  };

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

  it.each(stallResetCases)("should reset stall timers on $name", async ({ runUpdate }) => {
    const { calls, controller } = await createControllerAfterThinking();

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallSoftMs / 2);
    await runUpdate(controller);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallSoftMs / 2);

    expect(countCallsForEmoji(calls, DEFAULT_EMOJIS.stallSoft)).toBe(0);
  });

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
