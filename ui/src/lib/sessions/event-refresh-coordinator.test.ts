// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createSessionEventRefreshCoordinator } from "./event-refresh-coordinator.ts";

describe("automatic session refresh pacing", () => {
  it.each([
    { duration: 100, cooldown: 5_000 },
    { duration: 2_000, cooldown: 6_000 },
    { duration: 6_000, cooldown: 15_000 },
  ])(
    "waits $cooldown ms after a $duration ms refresh and debounces after idle",
    async ({ duration, cooldown }) => {
      vi.useFakeTimers();
      const refresh = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, duration);
          }),
      );
      const coordinator = createSessionEventRefreshCoordinator({ active: true, refresh });
      try {
        coordinator.schedule();
        await vi.advanceTimersByTimeAsync(4_999);
        expect(refresh).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        coordinator.schedule();
        await vi.advanceTimersByTimeAsync(duration + cooldown - 1);
        expect(refresh).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(refresh).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(duration + cooldown + 1);
        coordinator.schedule();
        await vi.advanceTimersByTimeAsync(4_999);
        expect(refresh).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(refresh).toHaveBeenCalledTimes(3);
      } finally {
        coordinator.dispose();
        await vi.advanceTimersByTimeAsync(duration);
        vi.useRealTimers();
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
      vi.useRealTimers();
    }
  });
});
