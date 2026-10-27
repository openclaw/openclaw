import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveToolEmoji,
  createStatusReactionController,
  DEFAULT_EMOJIS,
  DEFAULT_TIMING,
  type StatusReactionAdapter,
} from "./status-reactions.js";

const createEnabledController = (
  overrides: Partial<Parameters<typeof createStatusReactionController>[0]> = {},
  singleSlot = false,
) => {
  const calls: string[] = [];
  const record = (method: string) =>
    vi.fn(async (emoji: string) => {
      calls.push(`${method}${emoji}`);
    });
  const adapter: StatusReactionAdapter = {
    setReaction: record("+"),
    ...(singleSlot
      ? {
          clearReaction: vi.fn(async () => {
            calls.push("clear");
          }),
        }
      : { removeReaction: record("-") }),
  };
  const controller = createStatusReactionController({
    enabled: true,
    adapter,
    initialEmoji: "👀",
    ...overrides,
  });
  return { calls, controller };
};

const collectEmojisForMethod = (calls: string[], method = "+") =>
  calls.filter((entry) => entry.startsWith(method)).map((entry) => entry.slice(1));
async function advance(action: () => unknown, ms = DEFAULT_TIMING.debounceMs) {
  void action();
  await vi.advanceTimersByTimeAsync(ms);
}
describe("resolveToolEmoji", () => {
  it.each(["unknown_tool", undefined])("uses the fallback emoji for %s", (tool) => {
    expect(resolveToolEmoji(tool, DEFAULT_EMOJIS)).toBe(DEFAULT_EMOJIS.tool);
  });

  it("preserves explicit status emoji overrides before exact tool display emojis", () => {
    const overrides = { coding: "🧪", web: "🛰️", tool: "🔧" };
    const emojis = { ...DEFAULT_EMOJIS, ...overrides };
    expect(resolveToolEmoji("exec", emojis, overrides)).toBe("🧪");
    expect(resolveToolEmoji("web_search", emojis, overrides)).toBe("🛰️");
    expect(resolveToolEmoji("message", emojis, overrides)).toBe("🔧");
  });
});

describe("createStatusReactionController", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ["setDone", DEFAULT_EMOJIS.done, DEFAULT_TIMING.doneHoldMs],
    ["setError", DEFAULT_EMOJIS.error, DEFAULT_TIMING.errorHoldMs],
  ] as const)("holds %s before an immediately queued restore", async (method, expected, holdMs) => {
    const { calls, controller } = createEnabledController();
    await advance(controller.setQueued, 0);
    const settled = vi.fn();
    const terminalPromise = controller[method]().then(settled);
    const restorePromise = controller.restoreInitial().then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["+👀", `+${expected}`, "-👀"]);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(holdMs - 1);
    expect(collectEmojisForMethod(calls)).toEqual(["👀", expected]);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([terminalPromise, restorePromise]);
    expect(calls).toEqual(["+👀", `+${expected}`, "-👀", "+👀", `-${expected}`]);
  });

  it("should only fire last state when rapidly changing (debounce)", async () => {
    const { calls, controller } = createEnabledController();
    await advance(controller.setThinking, 100);
    await advance(() => controller.setTool("web_search"), 100);
    await advance(() => controller.setTool("exec"));
    expect(collectEmojisForMethod(calls)).toEqual(["🛠️"]);
  });

  it("should cancel a pending compacting emoji before resuming thinking", async () => {
    const { calls, controller } = createEnabledController();
    await advance(controller.setCompacting, DEFAULT_TIMING.debounceMs - 1);
    controller.cancelPending();
    await advance(controller.setThinking);
    expect(collectEmojisForMethod(calls)).toEqual([DEFAULT_EMOJIS.thinking]);
  });

  it("uses clearReaction only for explicit clear on single-slot adapters", async () => {
    const { calls, controller } = createEnabledController({}, true);
    void controller.setQueued();
    await vi.runAllTimersAsync();
    await advance(controller.setThinking);
    const donePromise = controller.setDone();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.doneHoldMs);
    await donePromise;
    await controller.restoreInitial();
    expect(calls).toEqual(["+👀", "+⏳", "+⚠️", "+🧠", "+✅", "+👀"]);
    await controller.clear();
    expect(calls.at(-1)).toBe("clear");
  });

  it("should cancel a terminal hold when explicitly cleared", async () => {
    const { calls, controller } = createEnabledController();
    await advance(controller.setQueued, 0);
    const terminalResolved = vi.fn();
    const terminalPromise = controller.setError().then(terminalResolved);
    await vi.advanceTimersByTimeAsync(0);
    expect(collectEmojisForMethod(calls)).toContain(DEFAULT_EMOJIS.error);
    expect(terminalResolved).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    const clearPromise = controller.clear();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([terminalPromise, clearPromise]);
    expect(terminalResolved).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(collectEmojisForMethod(calls, "-")).toEqual(["👀", DEFAULT_EMOJIS.error]);
  });

  it.each(["phase change", "repeated same-phase updates"])(
    "resets stall timers on %s",
    async (update) => {
      const { calls, controller } = createEnabledController();
      await advance(controller.setThinking);

      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallSoftMs / 2);
      if (update === "phase change") {
        await advance(() => controller.setTool("exec"));
      } else {
        await controller.setThinking();
      }
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallSoftMs / 2);

      expect(calls).not.toContain(`+${DEFAULT_EMOJIS.stallSoft}`);
      expect(calls).not.toContain(`-${DEFAULT_EMOJIS.stallSoft}`);
    },
  );

  it("should call onError callback when adapter throws", async () => {
    const onError = vi.fn();
    const setReaction = vi
      .fn<StatusReactionAdapter["setReaction"]>()
      .mockRejectedValue(new Error("Network error"));
    const { controller } = createEnabledController({ adapter: { setReaction }, onError });
    void controller.setQueued();
    await vi.runAllTimersAsync();
    expect(onError).toHaveBeenCalled();
  });
});
