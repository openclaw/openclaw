import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveToolEmoji,
  createStatusReactionController,
  DEFAULT_EMOJIS,
  DEFAULT_TIMING,
  type StatusReactionAdapter,
} from "./status-reactions.js";

type ReactionCall = { method: string; emoji: string };
const call = (method: string, emoji: string): ReactionCall => ({ method, emoji });

const createEnabledController = (
  overrides: Partial<Parameters<typeof createStatusReactionController>[0]> = {},
  singleSlot = false,
) => {
  const calls: ReactionCall[] = [];
  const record = (method: string) =>
    vi.fn(async (emoji: string) => {
      calls.push(call(method, emoji));
    });
  const adapter: StatusReactionAdapter = {
    setReaction: record("set"),
    ...(singleSlot
      ? {
          clearReaction: vi.fn(async () => {
            calls.push(call("clear", ""));
          }),
        }
      : { removeReaction: record("remove") }),
  };
  const controller = createStatusReactionController({
    enabled: true,
    adapter,
    initialEmoji: "👀",
    ...overrides,
  });
  return { adapter, calls, controller };
};

const collectEmojisForMethod = (calls: ReactionCall[], method: string) =>
  calls.filter((entry) => entry.method === method).map((entry) => entry.emoji);
const countCallsForEmoji = (calls: ReactionCall[], emoji: string) =>
  calls.filter((entry) => entry.emoji === emoji).length;
describe("resolveToolEmoji", () => {
  it.each(["unknown_tool", undefined])("uses the fallback emoji for %s", (tool) => {
    expect(resolveToolEmoji(tool, DEFAULT_EMOJIS)).toBe(DEFAULT_EMOJIS.tool);
  });

  it("preserves explicit status emoji overrides before exact tool display emojis", () => {
    const overrides = {
      coding: "🧪",
      web: "🛰️",
      tool: "🔧",
    };
    const emojis = { ...DEFAULT_EMOJIS, ...overrides };

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

  it.each([
    ["setDone", DEFAULT_EMOJIS.done, DEFAULT_TIMING.doneHoldMs],
    ["setError", DEFAULT_EMOJIS.error, DEFAULT_TIMING.errorHoldMs],
  ] as const)("holds %s before an immediately queued restore", async (method, expected, holdMs) => {
    const { calls, controller } = createEnabledController();

    void controller.setQueued();
    await vi.advanceTimersByTimeAsync(0);

    const settled = { terminal: false, restore: false };
    const terminalPromise = controller[method]().then(() => {
      settled.terminal = true;
    });
    const restorePromise = controller.restoreInitial().then(() => {
      settled.restore = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual([call("set", "👀"), call("set", expected), call("remove", "👀")]);
    expect(settled).toEqual({ terminal: false, restore: false });

    await vi.advanceTimersByTimeAsync(holdMs - 1);

    expect(collectEmojisForMethod(calls, "set")).toEqual(["👀", expected]);
    expect(settled).toEqual({ terminal: false, restore: false });

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([terminalPromise, restorePromise]);

    expect(calls).toEqual([
      call("set", "👀"),
      call("set", expected),
      call("remove", "👀"),
      call("set", "👀"),
      call("remove", expected),
    ]);
    expect(settled).toEqual({ terminal: true, restore: true });
    expect(countCallsForEmoji(calls, expected)).toBe(2);
  });

  it("should only fire last state when rapidly changing (debounce)", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(100);

    void controller.setTool("web_search");
    await vi.advanceTimersByTimeAsync(100);

    void controller.setTool("exec");
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

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
    const { calls, controller } = createEnabledController({}, true);

    void controller.setQueued();
    await vi.runAllTimersAsync();
    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    const donePromise = controller.setDone();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.doneHoldMs);
    await donePromise;
    await controller.restoreInitial();

    expect(calls).toEqual(
      [
        "👀",
        DEFAULT_EMOJIS.stallSoft,
        DEFAULT_EMOJIS.stallHard,
        DEFAULT_EMOJIS.thinking,
        DEFAULT_EMOJIS.done,
        "👀",
      ].map((emoji) => call("set", emoji)),
    );

    await controller.clear();
    expect(calls.at(-1)).toEqual(call("clear", ""));
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

    expect(collectEmojisForMethod(calls, "set")).toContain(DEFAULT_EMOJIS.error);
    expect(terminalResolved).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    const clearPromise = controller.clear();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([terminalPromise, clearPromise]);

    expect(terminalResolved).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(collectEmojisForMethod(calls, "remove")).toEqual(["👀", DEFAULT_EMOJIS.error]);
  });

  it.each(["phase change", "repeated same-phase updates"])(
    "resets stall timers on %s",
    async (update) => {
      const { calls, controller } = createEnabledController();
      void controller.setThinking();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallSoftMs / 2);
      if (update === "phase change") {
        void controller.setTool("exec");
        await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
      } else {
        await controller.setThinking();
      }
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallSoftMs / 2);

      expect(countCallsForEmoji(calls, DEFAULT_EMOJIS.stallSoft)).toBe(0);
    },
  );

  it("should call onError callback when adapter throws", async () => {
    const onError = vi.fn();
    const adapter: StatusReactionAdapter = {
      setReaction: vi.fn(async () => {
        throw new Error("Network error");
      }),
    };

    const { controller } = createEnabledController({ adapter, onError });

    void controller.setQueued();
    await vi.runAllTimersAsync();

    expect(onError).toHaveBeenCalled();
  });
});
