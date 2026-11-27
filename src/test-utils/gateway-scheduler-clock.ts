import { GatewayScheduler, type GatewaySchedulerClock } from "../infra/gateway-scheduler.js";

export function createTestGatewayScheduler(
  clock: GatewaySchedulerClock | "fake-timers" = createGatewaySchedulerClock(Date.now()).clock,
): GatewayScheduler {
  const schedulerClock: GatewaySchedulerClock =
    clock === "fake-timers"
      ? {
          now: () => Date.now(),
          monotonicNow: () => performance.now(),
          arm: (run, delayMs) => {
            const timer = setTimeout(() => {
              void run();
            }, delayMs);
            timer.unref();
            return () => clearTimeout(timer);
          },
        }
      : clock;
  return new GatewayScheduler({ clock: schedulerClock });
}

/** A host wake is explicit; advancing the wall clock never replays missed ticks. */
export function createGatewaySchedulerClock(initialNowMs = 0) {
  let nowMs = initialNowMs;
  let elapsedMs = 0;
  let armed: { run: () => void | Promise<void>; atMs: number; elapsedAtMs: number } | undefined;
  const wakes: Array<{
    run: () => void | Promise<void>;
    atMs: number;
    delayMs: number;
    cancelled: boolean;
  }> = [];
  const clock: GatewaySchedulerClock = {
    now: () => nowMs,
    monotonicNow: () => elapsedMs,
    arm: (run, delayMs) => {
      if (armed) {
        throw new Error("Gateway armed more than one host timer");
      }
      const timer = {
        run: () => {
          if (armed === timer) {
            armed = undefined;
          }
          if (!timer.cancelled) {
            elapsedMs = Math.max(elapsedMs, timer.elapsedAtMs);
          }
          return run();
        },
        atMs: nowMs + delayMs,
        elapsedAtMs: elapsedMs + delayMs,
        delayMs,
        cancelled: false,
      };
      armed = timer;
      wakes.push(timer);
      return () => {
        timer.cancelled = true;
        if (armed === timer) {
          armed = undefined;
        }
      };
    },
  };
  const wake = () => {
    const timer = armed;
    armed = undefined;
    return timer?.run();
  };
  const advanceTo = (timeMs: number) => {
    elapsedMs += Math.max(0, timeMs - nowMs);
    nowMs = timeMs;
    if (armed && armed.elapsedAtMs <= elapsedMs) {
      return wake();
    }
  };
  return {
    clock,
    wakes,
    advanceTo,
    advanceBy: (deltaMs: number) => advanceTo(nowMs + deltaMs),
    setTime: (timeMs: number) => {
      nowMs = timeMs;
    },
    wake,
    get armedAtMs() {
      return armed?.atMs ?? null;
    },
  };
}
