/**
 * Tests that the progress-draft gate routes timer-fired startup rejections to
 * onStartError instead of silently dropping them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelProgressDraftGate } from "./streaming.js";

describe("createChannelProgressDraftGate timer startup errors", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a timer-fired onStart rejection to onStartError", async () => {
    vi.useFakeTimers();
    const error = new Error("draft unavailable");
    const onStart = vi.fn<() => Promise<void>>().mockRejectedValueOnce(error);
    const onStartError = vi.fn();
    const gate = createChannelProgressDraftGate({ onStart, onStartError });

    await expect(gate.noteWork()).resolves.toBe(false);
    expect(onStartError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(gate.hasStarted).toBe(false);
    expect(onStartError).toHaveBeenCalledTimes(1);
    expect(onStartError).toHaveBeenCalledWith(error);
  });

  it("does not invoke onStartError when the timer start resolves", async () => {
    vi.useFakeTimers();
    const onStart = vi.fn(async () => {});
    const onStartError = vi.fn();
    const gate = createChannelProgressDraftGate({ onStart, onStartError });

    await expect(gate.noteWork()).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(gate.hasStarted).toBe(true);
    expect(onStartError).not.toHaveBeenCalled();
  });
});
