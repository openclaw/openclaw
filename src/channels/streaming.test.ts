/**
 * Tests that the progress-draft gate routes timer-fired startup rejections to
 * onStartError (or its default boundary logger) instead of silently dropping them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelProgressDraftGate } from "./streaming.js";

describe("createChannelProgressDraftGate timer startup errors", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it("warns via the default boundary reporter when no onStartError is supplied", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new Error("draft unavailable");
    const onStart = vi.fn<() => Promise<void>>().mockRejectedValueOnce(error);
    // No onStartError: the gate must fall back to the boundary reporter.
    const gate = createChannelProgressDraftGate({ onStart });

    await expect(gate.noteWork()).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("channel progress draft failed to start"),
    );
  });
});
