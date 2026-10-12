import { afterEach, expect, it, vi } from "vitest";
import { ObservationSampleCloseError } from "../../infra/fs-observation-snapshot.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createSkillFileScheduler, type SkillFileSnapshot } from "./refresh-file-stability.js";

const schedulers: Array<ReturnType<typeof createSkillFileScheduler>> = [];
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map((scheduler) => scheduler.close()));
  vi.useRealTimers();
});
function fixture(
  sample = vi.fn<(path: string) => Promise<SkillFileSnapshot | undefined>>(async () => ({
    size: 1,
    mtimeMs: 1,
  })),
) {
  if (!vi.isFakeTimers()) {
    vi.useFakeTimers();
  }
  const schedule = vi.fn();
  const onError = vi.fn();
  const scheduler = createSkillFileScheduler({ stabilityMs: 250, sample, schedule, onError });
  schedulers.push(scheduler);
  return { scheduler, sample, schedule, onError };
}

it("renews repeated hints without starving a stable sibling", async () => {
  const f = fixture();
  f.scheduler.schedule("first/SKILL.md");
  f.scheduler.schedule("busy/SKILL.md");
  await vi.advanceTimersByTimeAsync(200);
  f.scheduler.schedule("busy/SKILL.md");
  await vi.advanceTimersByTimeAsync(50);
  expect(f.schedule.mock.calls).toEqual([["first/SKILL.md"]]);
  await vi.advanceTimersByTimeAsync(199);
  expect(f.schedule.mock.calls).toEqual([["first/SKILL.md"]]);
  await vi.advanceTimersByTimeAsync(51);
  expect(f.schedule.mock.calls).toEqual([["first/SKILL.md"], ["busy/SKILL.md"]]);
});

it("invalidates a vanished discovery file without waiting for writer completion", async () => {
  const f = fixture(vi.fn(async () => undefined));
  f.scheduler.schedule("SKILL.md");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.schedule).toHaveBeenCalledExactlyOnceWith("SKILL.md");
});

it("joins a retired held sample without blocking a replacement or publishing late hints", async () => {
  const held = createDeferredCore<SkillFileSnapshot | undefined>();
  const old = fixture(vi.fn(() => held.promise));
  old.scheduler.schedule("SKILL.md");
  await Promise.resolve();
  let closed = false;
  const closing = old.scheduler.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  old.scheduler.schedule("late/SKILL.md");
  const next = fixture();
  next.scheduler.schedule("SKILL.md");
  try {
    await vi.advanceTimersByTimeAsync(250);
    expect(next.schedule).toHaveBeenCalledExactlyOnceWith("SKILL.md");
  } finally {
    held.resolve({ size: 1, mtimeMs: 1 });
    await closing;
  }
  expect(old.sample).toHaveBeenCalledTimes(1);
  expect(old.schedule).not.toHaveBeenCalled();
  expect(old.onError).not.toHaveBeenCalled();
});

it.each([
  { phase: "active", cleanup: false },
  { phase: "retired", cleanup: false },
  { phase: "active", cleanup: true },
  { phase: "retired", cleanup: true },
])("handles sample failure while $phase (cleanup: $cleanup)", async ({ phase, cleanup }) => {
  const held = createDeferredCore<SkillFileSnapshot | undefined>();
  const f = fixture(vi.fn(() => held.promise));
  f.scheduler.schedule("SKILL.md");
  await Promise.resolve();
  const cause = new Error("sample failed");
  const error = cleanup ? new ObservationSampleCloseError(cause) : cause;
  const closing = phase === "retired" ? f.scheduler.close() : undefined;
  held.reject(error);
  if (closing) {
    if (cleanup) {
      await expect(closing).rejects.toBe(error);
    } else {
      await expect(closing).resolves.toBeUndefined();
    }
    expect(f.onError).not.toHaveBeenCalled();
  } else {
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onError).toHaveBeenCalledExactlyOnceWith("SKILL.md", error);
  }
  expect(f.schedule).not.toHaveBeenCalled();
  if (cleanup) {
    expect(error.cause).toBe(cause);
    await expect(f.scheduler.close()).rejects.toBe(error);
    schedulers.splice(schedulers.indexOf(f.scheduler), 1);
  } else {
    if (!closing) {
      f.sample.mockResolvedValue({ size: 2, mtimeMs: 2 });
      f.scheduler.schedule("SKILL.md");
      await vi.advanceTimersByTimeAsync(250);
      expect(f.schedule).toHaveBeenCalledExactlyOnceWith("SKILL.md");
    }
    await expect(f.scheduler.close()).resolves.toBeUndefined();
  }
});

it.each(["initial", "final"] as const)(
  "resamples a recreated file when its %s missing sample was superseded",
  async (phase) => {
    const held = createDeferredCore<SkillFileSnapshot | undefined>();
    const sample = vi.fn(async (): Promise<SkillFileSnapshot | undefined> => ({
      size: 1,
      mtimeMs: 1,
    }));
    if (phase === "initial") {
      sample.mockImplementationOnce(() => held.promise);
    } else {
      sample
        .mockResolvedValueOnce({ size: 1, mtimeMs: 1 })
        .mockResolvedValueOnce({ size: 1, mtimeMs: 1 })
        .mockResolvedValueOnce({ size: 1, mtimeMs: 1 })
        .mockImplementationOnce(() => held.promise);
    }
    const f = fixture(sample);
    f.scheduler.schedule("SKILL.md");
    await vi.advanceTimersByTimeAsync(phase === "initial" ? 0 : 250);
    f.scheduler.schedule("SKILL.md");
    held.resolve(undefined);
    await vi.advanceTimersByTimeAsync(249);
    expect(f.schedule).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.schedule).toHaveBeenCalledExactlyOnceWith("SKILL.md");
  },
);

it("preserves a hint synchronously enqueued during settled publication", async () => {
  const f = fixture();
  f.schedule.mockImplementationOnce(() => f.scheduler.schedule("SKILL.md"));
  f.scheduler.schedule("SKILL.md");
  await vi.advanceTimersByTimeAsync(250);
  expect(f.schedule).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(249);
  expect(f.schedule).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.schedule).toHaveBeenCalledTimes(2);
});

it("bounds held samples and preserves invalidation on detail overflow", async () => {
  const held = createDeferredCore<SkillFileSnapshot | undefined>();
  const f = fixture(vi.fn(() => held.promise));
  for (let index = 0; index < 1024; index += 1) {
    f.scheduler.schedule(index + "/SKILL.md");
  }
  f.scheduler.schedule("overflow/SKILL.md");
  await Promise.resolve();
  expect(f.sample).toHaveBeenCalledTimes(1024);
  expect(f.schedule).toHaveBeenCalledExactlyOnceWith("overflow/SKILL.md");
  const closing = f.scheduler.close();
  held.resolve(undefined);
  await closing;
  expect(f.schedule).toHaveBeenCalledTimes(1);
});
