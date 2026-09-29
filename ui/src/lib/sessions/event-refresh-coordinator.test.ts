// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionEventRefreshCoordinator } from "./event-refresh-coordinator.ts";

describe("automatic session refresh pacing", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("spreads simultaneous invalidations without postponing their armed deadlines", async () => {
    vi.useFakeTimers();
    const refreshFirst = vi.fn(async () => {});
    const refreshSecond = vi.fn(async () => {});
    const first = createSessionEventRefreshCoordinator({ active: true, refresh: refreshFirst });
    const second = createSessionEventRefreshCoordinator({ active: true, refresh: refreshSecond });
    try {
      first.schedule();
      vi.mocked(Math.random).mockReturnValue(0.5);
      second.schedule();
      await vi.advanceTimersByTimeAsync(3_000);
      vi.mocked(Math.random).mockReturnValue(0.9);
      first.schedule();
      second.schedule();

      await vi.advanceTimersByTimeAsync(1_499);
      expect(refreshFirst).not.toHaveBeenCalled();
      expect(refreshSecond).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshSecond).toHaveBeenCalledOnce();
      expect(refreshFirst).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(refreshFirst).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(refreshFirst).toHaveBeenCalledOnce();
      expect(refreshSecond).toHaveBeenCalledOnce();
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it.each([
    { duration: 100, cooldown: 5_000, draw: 0, collection: 5_000 },
    { duration: 2_000, cooldown: 6_000, draw: 0.5, collection: 4_500 },
    { duration: 6_000, cooldown: 15_000, draw: 0.75, collection: 4_250 },
  ])(
    "waits $cooldown ms after a $duration ms refresh and debounces after idle",
    async ({ duration, cooldown, draw, collection }) => {
      vi.useFakeTimers();
      vi.mocked(Math.random).mockReturnValue(draw);
      const refresh = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, duration);
          }),
      );
      const coordinator = createSessionEventRefreshCoordinator({ active: true, refresh });
      try {
        coordinator.schedule();
        await vi.advanceTimersByTimeAsync(collection - 1);
        expect(refresh).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        coordinator.schedule();
        await vi.advanceTimersByTimeAsync(duration + cooldown - 1);
        expect(refresh).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(refresh).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(duration + cooldown + 1);
        coordinator.schedule();
        await vi.advanceTimersByTimeAsync(collection - 1);
        expect(refresh).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(refresh).toHaveBeenCalledTimes(3);
      } finally {
        coordinator.dispose();
        await vi.advanceTimersByTimeAsync(duration);
      }
    },
  );

  it("holds pending and in-flight invalidation while inactive and catches up once", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 1_000);
        }),
    );
    const coordinator = createSessionEventRefreshCoordinator({ active: true, refresh });
    try {
      coordinator.schedule();
      coordinator.setActive(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(refresh).not.toHaveBeenCalled();
      coordinator.setActive(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(refresh).toHaveBeenCalledTimes(1);
      coordinator.schedule();
      coordinator.setActive(false);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(refresh).toHaveBeenCalledTimes(1);
      coordinator.setActive(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(refresh).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      coordinator.dispose();
    }
  });
});
