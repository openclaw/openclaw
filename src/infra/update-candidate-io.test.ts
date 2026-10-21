import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withUpdateCandidateIoBudget } from "./update-candidate-io.js";
import { captureUpdateCandidateDeadline } from "./update-candidate-state.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function pendingIo(options: Partial<Parameters<typeof withUpdateCandidateIoBudget>[0]> = {}) {
  const exit = createDeferred();
  const state: { signal?: AbortSignal; settled: boolean } = { settled: false };
  const directory = options.directory ?? tempDirs.make("openclaw-io-");
  const operation = withUpdateCandidateIoBudget({ bytes: 0, ...options, directory }, (signal) => {
    state.signal = signal;
    return exit.promise;
  }).finally(() => {
    state.settled = true;
  });
  return { exit, state, operation };
}

it.each([
  { bytes: 0, timeoutMs: 1, allowance: 300_000 },
  { bytes: 32 * 1024 ** 2, timeoutMs: undefined, allowance: 340_000 },
  { bytes: 0, timeoutMs: 600_000, allowance: 600_000 },
])(
  "keeps the $allowance ms allowance and drains accepted work",
  async ({ bytes, timeoutMs, allowance }) => {
    vi.useFakeTimers();
    const { exit, state, operation } = pendingIo({ bytes, timeoutMs });
    const rejected = expect(operation).rejects.toThrow(
      `exceeded its ${allowance / 1000} second allowance`,
    );
    await vi.advanceTimersByTimeAsync(allowance - 1);
    expect(state.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toMatchObject({ signal: { aborted: true }, settled: false });
    exit.resolve();
    await rejected;
  },
);

it("checks completion against the absolute allowance before its timer runs", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const { exit, operation } = pendingIo({ bytes: 32 * 1024 ** 2 });
  const rejected = expect(operation).rejects.toThrow("exceeded its 340 second allowance");
  clock.mockReturnValue(now + 340_000);
  exit.resolve();
  await rejected;
});

it("expires the active snapshot after a completed inspection with a moving clock", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const expireDeadline = captureUpdateCandidateDeadline();
  const directory = tempDirs.make("openclaw-io-active-deadline-");
  await withUpdateCandidateIoBudget({ directory, bytes: 0 }, async () => undefined);
  clock.mockImplementation(() => now++);

  const pending = pendingIo({ directory, operation: "snapshot" });
  const operation = pending.operation.catch((error: unknown) => error);
  try {
    clock.mockReturnValue(now + 400_000);
    expireDeadline();
    expect(pending.state.signal?.reason).toMatchObject({
      message: expect.stringMatching(/snapshot exceeded its.*Check storage performance/),
    });
    expect(pending.state.settled).toBe(false);
  } finally {
    pending.exit.resolve();
    await operation;
  }
  expect(await operation).toBe(pending.state.signal?.reason);
});

it("drains accepted work after caller cancellation", async () => {
  const caller = new AbortController();
  const reason = new Error("cancel update I/O");
  const { exit, state, operation } = pendingIo({ signal: caller.signal });
  const rejected = expect(operation).rejects.toBe(reason);
  caller.abort(reason);
  expect(state).toMatchObject({ signal: { aborted: true }, settled: false });
  exit.resolve();
  await rejected;
});

it("preserves uncertain worker settlement instead of replacing it with expiry", async () => {
  vi.useFakeTimers();
  const failure = Object.assign(new Error("worker settlement uncertain"), { cleanup: "uncertain" });
  const { exit, operation } = pendingIo();
  const rejected = expect(operation).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(300_000);
  exit.reject(failure);
  await rejected;
});
