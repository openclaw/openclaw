import { expect, vi } from "vitest";

type WaitResult = {
  code: number | null;
  signal: number | NodeJS.Signals | null;
};

/** Assert fallback SIGKILL resolves only after the grace timer expires. */
export async function expectWaitStaysPendingUntilSigkillFallback(
  waitPromise: Promise<WaitResult>,
  triggerKill: () => void,
): Promise<void> {
  const settled = vi.fn();
  void waitPromise.then(() => settled());

  triggerKill();

  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(3999);
  expect(settled).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  await expect(waitPromise).resolves.toEqual({ code: null, signal: "SIGKILL" });
}
