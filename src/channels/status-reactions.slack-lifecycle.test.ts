import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStatusReactionController,
  DEFAULT_EMOJIS,
  DEFAULT_TIMING,
  type StatusReactionAdapter,
} from "./status-reactions.js";
const WEB_SEARCH_TOOL_EMOJI = "🔎";

function createSlackMockAdapter(
  options: Partial<Omit<Parameters<typeof createStatusReactionController>[0], "adapter">> = {},
) {
  const active = new Set<string>();
  const log: string[] = [];

  const adapter: StatusReactionAdapter = {
    setReaction: vi.fn(async (emoji: string) => {
      if (active.has(emoji)) {
        throw new Error("already_reacted");
      }
      active.add(emoji);
      log.push(`+${emoji}`);
    }),
    removeReaction: vi.fn(async (emoji: string) => {
      if (!active.has(emoji)) {
        throw new Error("no_reaction");
      }
      active.delete(emoji);
      log.push(`-${emoji}`);
    }),
  };
  const ctrl = createStatusReactionController({
    enabled: true,
    adapter,
    initialEmoji: "eyes",
    ...options,
  });
  const queue = async () => {
    void ctrl.setQueued();
    await vi.advanceTimersByTimeAsync(1);
    expect(active.has("eyes")).toBe(true);
  };
  return { adapter, active, log, ctrl, queue };
}

describe("Multi-reaction status lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps acknowledgement stable through activity, silence, success, and restoreInitial", async () => {
    const { active, log, ctrl } = createSlackMockAdapter({
      initialEmoji: "working",
      presentation: "acknowledgement",
    });

    void ctrl.setQueued();
    await vi.advanceTimersByTimeAsync(0);
    for (const update of [ctrl.setThinking, () => ctrl.setTool("exec"), ctrl.setCompacting]) {
      void update();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
    }
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallHardMs + 1);
    expect(log).toEqual(["+working"]);

    const donePromise = ctrl.setDone();
    await vi.advanceTimersByTimeAsync(0);
    await donePromise;
    await ctrl.restoreInitial();
    void ctrl.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallHardMs + 1);

    expect(log).toEqual(["+working"]);
    expect([...active]).toEqual(["working"]);
  });

  it("restoreInitial clears stall timers without re-adding queued emoji", async () => {
    const { adapter, active, ctrl, queue } = createSlackMockAdapter({
      timing: { debounceMs: 0, stallSoftMs: 10, stallHardMs: 20 },
    });

    await queue();
    expect(adapter.setReaction).toHaveBeenCalledTimes(1);

    await ctrl.restoreInitial();
    await vi.advanceTimersByTimeAsync(30);

    expect(adapter.setReaction).toHaveBeenCalledTimes(1);
    expect([...active]).toEqual(["eyes"]);
  });

  it("restoreInitial still applies initial emoji when it is only debounced", async () => {
    const { adapter, active, ctrl, queue } = createSlackMockAdapter({
      emojis: { thinking: "eyes" },
      timing: { debounceMs: 20, stallSoftMs: 99999, stallHardMs: 99999 },
    });

    await queue();

    void ctrl.setTool("web_search");
    await vi.advanceTimersByTimeAsync(25);
    expect(active.has(WEB_SEARCH_TOOL_EMOJI)).toBe(true);
    expect(active.has("eyes")).toBe(true);

    void ctrl.setThinking();
    await ctrl.restoreInitial();

    expect([...active]).toEqual(["eyes"]);
    expect(adapter.setReaction).toHaveBeenCalledTimes(2);
  });

  it("restoreInitial re-applies initial emoji after an in-flight debounced transition", async () => {
    let releaseThinking: (() => void) | undefined;
    const { adapter, active, ctrl, queue } = createSlackMockAdapter({
      timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
    });
    adapter.setReaction = vi.fn(async (emoji: string) => {
      if (emoji === DEFAULT_EMOJIS.thinking) {
        await new Promise<void>((resolve) => {
          releaseThinking = resolve;
        });
      }
      if (active.has(emoji)) {
        throw new Error("already_reacted");
      }
      active.add(emoji);
    });

    await queue();

    void ctrl.setThinking();
    await vi.advanceTimersByTimeAsync(1);

    const restorePromise = ctrl.restoreInitial();
    releaseThinking?.();
    await restorePromise;

    expect([...active]).toEqual(["eyes"]);
  });

  it("does nothing when disabled", async () => {
    const { adapter, active, ctrl } = createSlackMockAdapter({ enabled: false });

    void ctrl.setQueued();
    void ctrl.setThinking();
    await ctrl.setDone();
    await vi.advanceTimersByTimeAsync(100);
    expect(active.size).toBe(0);
    expect(adapter.setReaction).not.toHaveBeenCalled();
  });
});
