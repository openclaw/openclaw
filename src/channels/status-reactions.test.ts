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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveToolEmoji", () => {
  it("should return coding emoji for exec tool", () => {
    const result = resolveToolEmoji("exec", DEFAULT_EMOJIS);
    expect(result).toBe(DEFAULT_EMOJIS.coding);
  });

  it("should return coding emoji for process tool", () => {
    const result = resolveToolEmoji("process", DEFAULT_EMOJIS);
    expect(result).toBe(DEFAULT_EMOJIS.coding);
  });

  it("should return web emoji for web_search tool", () => {
    const result = resolveToolEmoji("web_search", DEFAULT_EMOJIS);
    expect(result).toBe(DEFAULT_EMOJIS.web);
  });

  it("should return web emoji for browser tool", () => {
    const result = resolveToolEmoji("browser", DEFAULT_EMOJIS);
    expect(result).toBe(DEFAULT_EMOJIS.web);
  });

  it("should return tool emoji for unknown tool", () => {
    const result = resolveToolEmoji("unknown_tool", DEFAULT_EMOJIS);
    expect(result).toBe(DEFAULT_EMOJIS.tool);
  });

  it("should return tool emoji for empty string", () => {
    const result = resolveToolEmoji("", DEFAULT_EMOJIS);
    expect(result).toBe(DEFAULT_EMOJIS.tool);
  });

  it("should return tool emoji for undefined", () => {
    const result = resolveToolEmoji(undefined, DEFAULT_EMOJIS);
    expect(result).toBe(DEFAULT_EMOJIS.tool);
  });

  it("should be case-insensitive", () => {
    const result = resolveToolEmoji("EXEC", DEFAULT_EMOJIS);
    expect(result).toBe(DEFAULT_EMOJIS.coding);
  });

  it("should match tokens within tool names", () => {
    const result = resolveToolEmoji("my_exec_wrapper", DEFAULT_EMOJIS);
    expect(result).toBe(DEFAULT_EMOJIS.coding);
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
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
    });

    void controller.setQueued();
    await vi.runAllTimersAsync();

    expect(calls).toContainEqual({ method: "set", emoji: "👀" });
  });

  it("should debounce setThinking and eventually call adapter", async () => {
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
    });

    void controller.setThinking();

    // Before debounce period
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(0);

    // After debounce period
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toContainEqual({ method: "set", emoji: DEFAULT_EMOJIS.thinking });
  });

  it("should classify tool name and debounce", async () => {
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
    });

    void controller.setTool("exec");
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    expect(calls).toContainEqual({ method: "set", emoji: DEFAULT_EMOJIS.coding });
  });

  it("should execute setDone immediately without debounce", async () => {
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
    });

    await controller.setDone();
    await vi.runAllTimersAsync();

    expect(calls).toContainEqual({ method: "set", emoji: DEFAULT_EMOJIS.done });
  });

  it("should execute setError immediately without debounce", async () => {
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
    });

    await controller.setError();
    await vi.runAllTimersAsync();

    expect(calls).toContainEqual({ method: "set", emoji: DEFAULT_EMOJIS.error });
  });

  it("should ignore setThinking after setDone (terminal state)", async () => {
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
    });

    await controller.setDone();
    const callsAfterDone = calls.length;

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(1000);

    expect(calls.length).toBe(callsAfterDone);
  });

  it("should ignore setTool after setError (terminal state)", async () => {
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
    });

    await controller.setError();
    const callsAfterError = calls.length;

    void controller.setTool("exec");
    await vi.advanceTimersByTimeAsync(1000);

    expect(calls.length).toBe(callsAfterError);
  });

  it("should only fire last state when rapidly changing (debounce)", async () => {
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
    });

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
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
    });

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    const callsAfterFirst = calls.length;

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    // Should not add another call
    expect(calls.length).toBe(callsAfterFirst);
  });

  it("should call removeReaction when adapter supports it and emoji changes", async () => {
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
    });

    void controller.setQueued();
    await vi.runAllTimersAsync();

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    // Should set thinking, then remove queued
    expect(calls).toContainEqual({ method: "set", emoji: DEFAULT_EMOJIS.thinking });
    expect(calls).toContainEqual({ method: "remove", emoji: "👀" });
  });

  it("should only call setReaction when adapter lacks removeReaction", async () => {
    const calls: { method: string; emoji: string }[] = [];
    const adapter: StatusReactionAdapter = {
      setReaction: vi.fn(async (emoji: string) => {
        calls.push({ method: "set", emoji });
      }),
      // No removeReaction
    };

    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
    });

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
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
    });

    void controller.setQueued();
    await vi.runAllTimersAsync();

    await controller.clear();

    // Should have removed multiple emojis
    const removeCalls = calls.filter((c) => c.method === "remove");
    expect(removeCalls.length).toBeGreaterThan(0);
  });

  it("should handle clear gracefully when adapter lacks removeReaction", async () => {
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

    await controller.clear();

    // Should not throw, no remove calls
    const removeCalls = calls.filter((c) => c.method === "remove");
    expect(removeCalls).toHaveLength(0);
  });

  it("should restore initial emoji", async () => {
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
    });

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    await controller.restoreInitial();

    expect(calls).toContainEqual({ method: "set", emoji: "👀" });
  });

  it("should use custom emojis when provided", async () => {
    const { adapter, calls } = createMockAdapter();
    const customEmojis = {
      thinking: "🤔",
      done: "🎉",
    };

    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
      emojis: customEmojis,
    });

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    expect(calls).toContainEqual({ method: "set", emoji: "🤔" });

    await controller.setDone();
    await vi.runAllTimersAsync();
    expect(calls).toContainEqual({ method: "set", emoji: "🎉" });
  });

  it("should use custom timing when provided", async () => {
    const { adapter, calls } = createMockAdapter();
    const customTiming = {
      debounceMs: 100,
    };

    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
      timing: customTiming,
    });

    void controller.setThinking();

    // Should not fire at 50ms
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toHaveLength(0);

    // Should fire at 100ms
    await vi.advanceTimersByTimeAsync(60);
    expect(calls).toContainEqual({ method: "set", emoji: DEFAULT_EMOJIS.thinking });
  });

  it("should trigger soft stall timer after stallSoftMs", async () => {
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
    });

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    // Advance to soft stall threshold
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallSoftMs);

    expect(calls).toContainEqual({ method: "set", emoji: DEFAULT_EMOJIS.stallSoft });
  });

  it("should trigger hard stall timer after stallHardMs", async () => {
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
    });

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    // Advance to hard stall threshold
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallHardMs);

    expect(calls).toContainEqual({ method: "set", emoji: DEFAULT_EMOJIS.stallHard });
  });

  it("should reset stall timers on phase change", async () => {
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
    });

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    // Advance halfway to soft stall
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallSoftMs / 2);

    // Change phase
    void controller.setTool("exec");
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    // Advance another halfway - should not trigger stall yet
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallSoftMs / 2);

    const stallCalls = calls.filter((c) => c.emoji === DEFAULT_EMOJIS.stallSoft);
    expect(stallCalls).toHaveLength(0);
  });

  it("should reset stall timers on repeated same-phase updates", async () => {
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
    });

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    // Advance halfway to soft stall
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallSoftMs / 2);

    // Re-affirm same phase (should reset timers)
    void controller.setThinking();

    // Advance another halfway - should not trigger stall yet
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallSoftMs / 2);

    const stallCalls = calls.filter((c) => c.emoji === DEFAULT_EMOJIS.stallSoft);
    expect(stallCalls).toHaveLength(0);
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

describe("constants", () => {
  it("should export CODING_TOOL_TOKENS", () => {
    expect(CODING_TOOL_TOKENS).toContain("exec");
    expect(CODING_TOOL_TOKENS).toContain("read");
    expect(CODING_TOOL_TOKENS).toContain("write");
  });

  it("should export WEB_TOOL_TOKENS", () => {
    expect(WEB_TOOL_TOKENS).toContain("web_search");
    expect(WEB_TOOL_TOKENS).toContain("browser");
  });

  it("should export DEFAULT_EMOJIS with all required keys", () => {
    expect(DEFAULT_EMOJIS).toHaveProperty("queued");
    expect(DEFAULT_EMOJIS).toHaveProperty("thinking");
    expect(DEFAULT_EMOJIS).toHaveProperty("tool");
    expect(DEFAULT_EMOJIS).toHaveProperty("coding");
    expect(DEFAULT_EMOJIS).toHaveProperty("web");
    expect(DEFAULT_EMOJIS).toHaveProperty("done");
    expect(DEFAULT_EMOJIS).toHaveProperty("error");
    expect(DEFAULT_EMOJIS).toHaveProperty("stallSoft");
    expect(DEFAULT_EMOJIS).toHaveProperty("stallHard");
  });

  it("should export DEFAULT_TIMING with all required keys", () => {
    expect(DEFAULT_TIMING).toHaveProperty("debounceMs");
    expect(DEFAULT_TIMING).toHaveProperty("stallSoftMs");
    expect(DEFAULT_TIMING).toHaveProperty("stallHardMs");
    expect(DEFAULT_TIMING).toHaveProperty("doneHoldMs");
    expect(DEFAULT_TIMING).toHaveProperty("errorHoldMs");
  });
});
