import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createStatusReactionController,
  DEFAULT_EMOJIS,
  DEFAULT_TIMING,
  type StatusReactionAdapter,
} from "./status-reactions.js";
type Options = Parameters<typeof createStatusReactionController>[0];
const defaults = { enabled: true, initialEmoji: "eyes" };
async function advance(action: () => Promise<void>, ms: number) {
  void action();
  await vi.advanceTimersByTimeAsync(ms);
}

function createSlackMockAdapter(options: Partial<Omit<Options, "adapter">> = {}) {
  const active = new Set<string>();
  const log: string[] = [];

  const mutate = (emoji: string, add: boolean) => {
    if (active.has(emoji) === add) {
      throw new Error(add ? "already_reacted" : "no_reaction");
    }
    const operation = add ? "add" : "delete";
    active[operation](emoji);
    log.push(`${add ? "+" : "-"}${emoji}`);
  };
  const adapter: StatusReactionAdapter = {
    setReaction: vi.fn(async (emoji: string) => mutate(emoji, true)),
    removeReaction: vi.fn(async (emoji: string) => mutate(emoji, false)),
  };
  const ctrl = createStatusReactionController({ ...defaults, adapter, ...options });
  const queue = async () => {
    await advance(ctrl.setQueued, 1);
    expect(active.has("eyes")).toBe(true);
  };
  return { adapter, active, log, ctrl, queue };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("keeps acknowledgement stable through activity, silence, success, and restoreInitial", async () => {
  const { active, log, ctrl } = createSlackMockAdapter({
    initialEmoji: "working",
    presentation: "acknowledgement",
  });

  await advance(ctrl.setQueued, 0);
  for (const update of [ctrl.setThinking, () => ctrl.setTool("exec"), ctrl.setCompacting]) {
    await advance(update, DEFAULT_TIMING.debounceMs);
  }
  await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallHardMs + 1);
  expect(log).toEqual(["+working"]);

  const donePromise = ctrl.setDone();
  await vi.advanceTimersByTimeAsync(0);
  await donePromise;
  await ctrl.restoreInitial();
  await advance(ctrl.setThinking, DEFAULT_TIMING.stallHardMs + 1);

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

  await advance(() => ctrl.setTool("web_search"), 25);
  expect([...active]).toEqual(["eyes", "🔎"]);

  void ctrl.setThinking();
  await ctrl.restoreInitial();

  expect([...active]).toEqual(["eyes"]);
  expect(adapter.setReaction).toHaveBeenCalledTimes(2);
});

it("restoreInitial re-applies initial emoji after an in-flight debounced transition", async () => {
  const thinking = createDeferred<void>();
  const { adapter, active, ctrl, queue } = createSlackMockAdapter({
    timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
  });
  const setReaction = adapter.setReaction;
  adapter.setReaction = vi.fn(async (emoji: string) => {
    if (emoji === DEFAULT_EMOJIS.thinking) {
      await thinking.promise;
    }
    await setReaction(emoji);
  });

  await queue();

  await advance(ctrl.setThinking, 1);

  const restorePromise = ctrl.restoreInitial();
  thinking.resolve();
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
