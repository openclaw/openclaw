import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelProgressDraftGate } from "./progress-draft-gate.js";

const DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS = 1_500;

afterEach(() => {
  vi.useRealTimers();
});

it("delays rapid work events and joins a single pending startup", async () => {
  vi.useFakeTimers();
  const pending = createDeferredCore();
  const onStart = vi.fn(() => pending.promise);
  const onStartError = vi.fn();
  const gate = createChannelProgressDraftGate({ onStart, onStartError });

  await expect(gate.noteWork()).resolves.toBe(false);
  await expect(gate.noteWork()).resolves.toBe(false);

  expect(gate.workEvents).toBe(2);
  expect(onStart).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS - 1);
  expect(onStart).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(gate.hasStarted).toBe(true);
  const explicitStart = gate.startNow();
  let workSettled = false;
  const workDuringStart = gate.noteWork().then((started) => {
    workSettled = true;
    return started;
  });
  await Promise.resolve();
  expect(workSettled).toBe(false);
  expect(onStart).toHaveBeenCalledTimes(1);
  pending.resolve();
  await expect(explicitStart).resolves.toBeUndefined();
  await expect(workDuringStart).resolves.toBe(true);
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(gate.hasStarted).toBe(true);
  gate.reset();
  const error = new Error("draft unavailable");
  onStart.mockRejectedValueOnce(error);
  await expect(gate.noteWork()).resolves.toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);

  expect(onStart).toHaveBeenCalledTimes(2);
  expect(gate.hasStarted).toBe(false);
  expect(onStartError).toHaveBeenCalledWith(error);

  await expect(gate.startNow()).resolves.toBeUndefined();

  expect(onStart).toHaveBeenCalledTimes(3);
  expect(gate.hasStarted).toBe(true);
});

it("keeps a superseded startup failure from unstarting the next turn", async () => {
  const superseded = createDeferredCore();
  const onStart = vi.fn().mockReturnValueOnce(superseded.promise).mockResolvedValue(undefined);
  const gate = createChannelProgressDraftGate({ onStart });

  const supersededStart = gate.startNow();
  await Promise.resolve();
  // Final delivery cancels, then the next queued turn reopens the gate.
  gate.cancel();
  gate.reset();
  await expect(gate.startNow()).resolves.toBeUndefined();
  superseded.reject(new Error("stale draft failed"));
  await expect(supersededStart).rejects.toThrow("stale draft failed");

  expect(gate.hasStarted).toBe(true);
  await expect(gate.noteWork()).resolves.toBe(true);
  expect(onStart).toHaveBeenCalledTimes(2);
});
