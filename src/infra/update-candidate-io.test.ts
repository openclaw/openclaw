import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withUpdateCandidateIoBudget } from "./update-candidate-io.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([
  { bytes: 0, timeoutMs: 1, allowance: 300_000 },
  { bytes: 32 * 1024 ** 2, timeoutMs: undefined, allowance: 340_000 },
  { bytes: 0, timeoutMs: 600_000, allowance: 600_000 },
])(
  "keeps the $allowance ms allowance and drains accepted work",
  async ({ bytes, timeoutMs, allowance }) => {
    vi.useFakeTimers();
    const exit = createDeferred();
    let workerSignal: AbortSignal | undefined;
    let settled = false;
    const operation = withUpdateCandidateIoBudget(
      { directory: tempDirs.make("openclaw-io-deadline-"), bytes, timeoutMs },
      (signal) => {
        workerSignal = signal;
        return exit.promise;
      },
    ).finally(() => {
      settled = true;
    });
    const rejected = expect(operation).rejects.toThrow(
      `exceeded its ${allowance / 1000} second allowance`,
    );
    await vi.advanceTimersByTimeAsync(allowance - 1);
    expect(workerSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(workerSignal?.aborted).toBe(true);
    expect(settled).toBe(false);
    exit.resolve();
    await rejected;
  },
);

it("checks completion against the absolute allowance before its timer runs", async () => {
  const exit = createDeferred();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const operation = withUpdateCandidateIoBudget(
    { directory: tempDirs.make("openclaw-io-completion-"), bytes: 32 * 1024 ** 2 },
    () => exit.promise,
  );
  const rejected = expect(operation).rejects.toThrow("exceeded its 340 second allowance");
  clock.mockReturnValue(now + 340_000);
  exit.resolve();
  await rejected;
});

it("drains accepted work after caller cancellation", async () => {
  const exit = createDeferred();
  const caller = new AbortController();
  const reason = new Error("cancel update I/O");
  let workerSignal: AbortSignal | undefined;
  let settled = false;
  const operation = withUpdateCandidateIoBudget(
    { directory: tempDirs.make("openclaw-io-cancel-"), bytes: 0, signal: caller.signal },
    (signal) => {
      workerSignal = signal;
      return exit.promise;
    },
  ).finally(() => {
    settled = true;
  });
  const rejected = expect(operation).rejects.toBe(reason);
  caller.abort(reason);
  expect(workerSignal?.aborted).toBe(true);
  expect(settled).toBe(false);
  exit.resolve();
  await rejected;
});

it("preserves uncertain worker settlement instead of replacing it with expiry", async () => {
  vi.useFakeTimers();
  const exit = createDeferred();
  const failure = Object.assign(new Error("worker settlement uncertain"), { cleanup: "uncertain" });
  const operation = withUpdateCandidateIoBudget(
    { directory: tempDirs.make("openclaw-io-settlement-"), bytes: 0 },
    () => exit.promise,
  );
  const rejected = expect(operation).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(300_000);
  exit.reject(failure);
  await rejected;
});
