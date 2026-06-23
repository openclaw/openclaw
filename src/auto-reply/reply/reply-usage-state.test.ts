import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearReplyUsageStateForTest,
  consumeReplyUsageState,
  recordReplyUsageState,
} from "./reply-usage-state.js";

afterEach(() => {
  vi.useRealTimers();
  clearReplyUsageStateForTest();
});

describe("reply usage state handoff", () => {
  it("requires exact run correlation", () => {
    const snapshot = { provider: "openai", model: "gpt-5.5" };

    recordReplyUsageState("run-a", snapshot);

    expect(consumeReplyUsageState()).toBeUndefined();
    expect(consumeReplyUsageState("run-b")).toBeUndefined();
    expect(consumeReplyUsageState("run-a")).toBe(snapshot);
  });

  it("ignores snapshots without a run id", () => {
    recordReplyUsageState(undefined, { provider: "openai" });

    expect(consumeReplyUsageState()).toBeUndefined();
  });

  it("expires snapshots", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    recordReplyUsageState("run-a", { provider: "openai" });

    vi.setSystemTime(5 * 60_000 + 1);

    expect(consumeReplyUsageState("run-a")).toBeUndefined();
  });
});
