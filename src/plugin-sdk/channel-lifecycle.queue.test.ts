import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createChannelRunQueue } from "./channel-lifecycle.core.js";
beforeEach(() => vi.useFakeTimers({ now: 1_000 }));
afterEach(() => vi.useRealTimers());

async function flushAsyncWork() {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

async function finish(task: ReturnType<typeof createDeferred<void>>) {
  task.resolve();
  await task.promise;
  await flushAsyncWork();
}

async function startConcurrentRuns() {
  const first = createDeferred();
  const second = createDeferred();
  const setStatus = vi.fn();
  const queue = createChannelRunQueue({ setStatus });
  queue.enqueue("first", async () => first.promise);
  await flushAsyncWork();
  vi.setSystemTime(2_000);
  queue.enqueue("second", async () => second.promise);
  await flushAsyncWork();
  return { first, second, setStatus, queue };
}

describe("createChannelRunQueue", () => {
  it("serializes work per key while allowing unrelated keys to run", async () => {
    const first = createDeferred();
    const second = createDeferred();
    const third = createDeferred();
    const order: string[] = [];
    const queue = createChannelRunQueue({});

    const track = (name: string, task: ReturnType<typeof createDeferred<void>>) => async () => {
      order.push(`start:${name}`);
      await task.promise;
      order.push(`end:${name}`);
    };
    queue.enqueue("same", track("first", first));
    queue.enqueue("same", track("second", second));
    queue.enqueue("other", track("third", third));

    await flushAsyncWork();
    expect(order).toEqual(["start:first", "start:third"]);

    await finish(third);
    expect(order).toEqual(["start:first", "start:third", "end:third"]);

    await finish(first);
    expect(order).toEqual(["start:first", "start:third", "end:third", "end:first", "start:second"]);

    second.resolve?.();
    await second.promise;
  });

  it.each([false, true])(
    "updates run status and contains reporting errors (throws=%s)",
    async (throws) => {
      const taskError = new Error("boom");
      const setStatus = vi.fn();
      const onError = vi.fn(() => {
        if (throws) {
          throw new Error("report failed");
        }
      });
      const queue = createChannelRunQueue({ setStatus, onError });

      queue.enqueue("key", async () => {
        throw taskError;
      });

      await flushAsyncWork();

      expect(
        setStatus.mock.calls.map(([s]) => [
          s.activeRuns,
          s.busy,
          s.activeRunStartedAt,
          s.lastRunActivityAt,
        ]),
      ).toEqual([
        [0, false, null, undefined],
        [1, true, expect.any(Number), expect.any(Number)],
        [0, false, null, expect.any(Number)],
      ]);
      expect(onError).toHaveBeenCalledWith(taskError);
    },
  );

  it.each([
    { done: "second", remaining: "first", startedAt: 1_000 },
    { done: "first", remaining: "second", startedAt: 2_000 },
  ] as const)(
    "tracks the oldest active run after $done completes",
    async ({ done, remaining, startedAt }) => {
      const runs = await startConcurrentRuns();
      await finish(runs[done]);
      expect(runs.setStatus.mock.calls.at(-1)?.[0]).toMatchObject({
        activeRuns: 1,
        busy: true,
        activeRunStartedAt: startedAt,
      });
      runs.queue.deactivate();
      runs[remaining].resolve();
      await runs[remaining].promise;
    },
  );

  it("skips queued work after deactivation", async () => {
    const first = createDeferred();
    const task = vi.fn();
    const queue = createChannelRunQueue({});

    queue.enqueue("key", async () => {
      await first.promise;
    });
    queue.enqueue("key", task);
    await flushAsyncWork();

    queue.deactivate();
    await finish(first);

    expect(task).not.toHaveBeenCalled();
  });
});
