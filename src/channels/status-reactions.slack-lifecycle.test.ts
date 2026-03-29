import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStatusReactionController,
  DEFAULT_EMOJIS,
  type StatusReactionAdapter,
} from "./status-reactions.js";

function createSlackMockAdapter() {
  const active = new Set<string>();
  const log: string[] = [];

  return {
    adapter: {
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
    } as StatusReactionAdapter,
    active,
    log,
  };
}

describe("Slack status reaction lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queued -> thinking -> tool -> done -> clear", async () => {
    const { adapter, active, log } = createSlackMockAdapter();
    const ctrl = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "eyes",
      timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
    });

    void ctrl.setQueued();
    await vi.advanceTimersByTimeAsync(10);
    expect(active.has("eyes")).toBe(true);

    void ctrl.setThinking();
    await vi.advanceTimersByTimeAsync(10);
    expect(active.has(DEFAULT_EMOJIS.thinking)).toBe(true);
    expect(active.has("eyes")).toBe(false);

    void ctrl.setTool("web_search");
    await vi.advanceTimersByTimeAsync(10);
    expect(active.has(DEFAULT_EMOJIS.web)).toBe(true);
    expect(active.has(DEFAULT_EMOJIS.thinking)).toBe(false);

    await ctrl.setDone();
    expect(active.has(DEFAULT_EMOJIS.done)).toBe(true);
    expect(active.has(DEFAULT_EMOJIS.web)).toBe(false);

    await ctrl.clear();
    expect(active.size).toBe(0);
    expect(log.length).toBeGreaterThan(0);
  });

  it("queued -> error -> restoreInitial", async () => {
    const { adapter, active } = createSlackMockAdapter();
    const ctrl = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "eyes",
      timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
    });

    void ctrl.setQueued();
    await vi.advanceTimersByTimeAsync(10);
    expect(active.has("eyes")).toBe(true);

    await ctrl.setError();
    expect(active.has(DEFAULT_EMOJIS.error)).toBe(true);
    expect(active.has("eyes")).toBe(false);

    await ctrl.restoreInitial();
    expect(active.has("eyes")).toBe(true);
    expect(active.has(DEFAULT_EMOJIS.error)).toBe(false);
  });

  it("does nothing when disabled", async () => {
    const { adapter, active } = createSlackMockAdapter();
    const ctrl = createStatusReactionController({
      enabled: false,
      adapter,
      initialEmoji: "eyes",
    });

    void ctrl.setQueued();
    void ctrl.setThinking();
    await ctrl.setDone();
    await vi.advanceTimersByTimeAsync(100);
    expect(active.size).toBe(0);
    expect(adapter.setReaction).not.toHaveBeenCalled();
  });

  it("coding tool resolves to coding emoji", async () => {
    const { adapter, active } = createSlackMockAdapter();
    const ctrl = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "eyes",
      timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
    });

    void ctrl.setQueued();
    await vi.advanceTimersByTimeAsync(10);

    void ctrl.setTool("exec");
    await vi.advanceTimersByTimeAsync(10);
    expect(active.has(DEFAULT_EMOJIS.coding)).toBe(true);
    expect(active.has("eyes")).toBe(false);
  });
});
