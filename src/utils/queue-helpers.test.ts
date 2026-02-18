import { describe, expect, it } from "vitest";
import {
  applyQueueRuntimeSettings,
  buildQueueSummaryPrompt,
  clearQueueSummaryState,
  previewQueueSummaryPrompt,
} from "./queue-helpers.js";

describe("applyQueueRuntimeSettings", () => {
  it("updates runtime queue settings with normalization", () => {
    const target = {
      mode: "followup" as const,
      debounceMs: 1000,
      cap: 20,
      dropPolicy: "summarize" as const,
    };

    applyQueueRuntimeSettings({
      target,
      settings: {
        mode: "collect",
        debounceMs: -12,
        cap: 9.8,
        dropPolicy: "new",
      },
    });

    expect(target).toEqual({
      mode: "collect",
      debounceMs: 0,
      cap: 9,
      dropPolicy: "new",
    });
  });

  it("keeps existing values when optional settings are missing/invalid", () => {
    const target = {
      mode: "followup" as const,
      debounceMs: 1000,
      cap: 20,
      dropPolicy: "summarize" as const,
    };

    applyQueueRuntimeSettings({
      target,
      settings: {
        mode: "queue",
        cap: 0,
      },
    });

    expect(target).toEqual({
      mode: "queue",
      debounceMs: 1000,
      cap: 20,
      dropPolicy: "summarize",
    });
  });
});

describe("queue summary helpers", () => {
  it("previewQueueSummaryPrompt does not mutate state", () => {
    const state = {
      dropPolicy: "summarize" as const,
      droppedCount: 2,
      summaryLines: ["first", "second"],
    };

    const prompt = previewQueueSummaryPrompt({
      state,
      noun: "message",
    });

    expect(prompt).toContain("[Queue overflow] Dropped 2 messages due to cap.");
    expect(prompt).toContain("first");
    expect(state).toEqual({
      dropPolicy: "summarize",
      droppedCount: 2,
      summaryLines: ["first", "second"],
    });
  });

  it("buildQueueSummaryPrompt clears state after rendering", () => {
    const state = {
      dropPolicy: "summarize" as const,
      droppedCount: 1,
      summaryLines: ["line"],
    };

    const prompt = buildQueueSummaryPrompt({
      state,
      noun: "announce",
    });

    expect(prompt).toContain("[Queue overflow] Dropped 1 announce due to cap.");
    expect(state).toEqual({
      dropPolicy: "summarize",
      droppedCount: 0,
      summaryLines: [],
    });
  });

  it("clearQueueSummaryState resets summary counters", () => {
    const state = {
      dropPolicy: "summarize" as const,
      droppedCount: 5,
      summaryLines: ["a", "b"],
    };
    clearQueueSummaryState(state);
    expect(state.droppedCount).toBe(0);
    expect(state.summaryLines).toEqual([]);
  });
});
