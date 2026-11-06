// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSessionEventRefreshCoordinator } from "./event-refresh-coordinator.ts";

const coordinators: ReturnType<typeof createSessionEventRefreshCoordinator>[] = [];
function setup(duration = 0) {
  const refresh = vi.fn(async () => {
    if (duration) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, duration);
      });
    }
  });
  const coordinator = createSessionEventRefreshCoordinator({ active: true, refresh });
  coordinators.push(coordinator);
  return { coordinator, refresh };
}
async function advance(ms: number, refresh: ReturnType<typeof setup>["refresh"], count: number) {
  await vi.advanceTimersByTimeAsync(ms);
  expect(refresh).toHaveBeenCalledTimes(count);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  coordinators.splice(0).forEach((coordinator) => coordinator.dispose());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("spreads simultaneous invalidations without postponing their armed deadlines", async () => {
  const { coordinator: first, refresh: refreshFirst } = setup();
  const { coordinator: second, refresh: refreshSecond } = setup();
  first.schedule();
  vi.mocked(Math.random).mockReturnValue(0.5);
  second.schedule();
  await vi.advanceTimersByTimeAsync(3_000);
  vi.mocked(Math.random).mockReturnValue(0.9);
  first.schedule();
  second.schedule();

  await vi.advanceTimersByTimeAsync(1_499);
  expect([refreshFirst, refreshSecond].map((mock) => mock.mock.calls.length)).toEqual([0, 0]);
  await vi.advanceTimersByTimeAsync(1);
  expect([refreshFirst, refreshSecond].map((mock) => mock.mock.calls.length)).toEqual([0, 1]);
  await advance(500, refreshFirst, 1);
  await vi.advanceTimersByTimeAsync(15_000);
  expect([refreshFirst, refreshSecond].map((mock) => mock.mock.calls.length)).toEqual([1, 1]);
});

it.each([
  { duration: 100, cooldown: 5_000, draw: 0, collection: 5_000 },
  { duration: 2_000, cooldown: 6_000, draw: 0.5, collection: 4_500 },
  { duration: 6_000, cooldown: 15_000, draw: 0.75, collection: 4_250 },
])(
  "backs off $cooldown ms after $duration ms, then debounces",
  async ({ duration, cooldown, draw, collection }) => {
    vi.mocked(Math.random).mockReturnValue(draw);
    const { coordinator, refresh } = setup(duration);
    coordinator.schedule();
    await advance(collection - 1, refresh, 0);
    await vi.advanceTimersByTimeAsync(1);
    coordinator.schedule();
    await advance(duration + cooldown - 1, refresh, 1);
    await advance(1, refresh, 2);
    await vi.advanceTimersByTimeAsync(duration + cooldown + 1);
    coordinator.schedule();
    await advance(collection - 1, refresh, 2);
    await advance(1, refresh, 3);
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(duration);
  },
);

it("holds pending and in-flight invalidation while inactive and catches up once", async () => {
  const { coordinator, refresh } = setup(1_000);
  coordinator.schedule();
  coordinator.setActive(false);
  await advance(10_000, refresh, 0);
  coordinator.setActive(true);
  await advance(0, refresh, 1);
  coordinator.schedule();
  coordinator.setActive(false);
  await advance(20_000, refresh, 1);
  coordinator.setActive(true);
  await advance(0, refresh, 2);
  await advance(20_000, refresh, 2);
});

it("keeps one minute fallback under row traffic and absorbs it on an authoritative read", async () => {
  const { coordinator, refresh } = setup();
  for (let second = 0; second < 60; second += 1) {
    coordinator.scheduleFallback();
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(refresh).not.toHaveBeenCalled();
  await advance(5_000, refresh, 1);
  coordinator.scheduleFallback();
  coordinator.absorb();
  await advance(65_000, refresh, 1);
});
