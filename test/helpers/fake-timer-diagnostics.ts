type PendingFakeTimer = {
  type?: string;
  delay?: number;
  callAt?: number;
  createdAt?: number;
  func?: unknown;
};

type DiagnosticClock = {
  timerHeap?: { timers: PendingFakeTimer[] };
  jobs?: Array<{ func?: unknown }>;
};

/** Diagnostic shape from the fake-timers clock bundled with Vitest. */
export function describePendingFakeTimers(): string {
  const clock = (globalThis.setTimeout as typeof setTimeout & { clock?: DiagnosticClock }).clock;
  const callback = (func: unknown) => String(func).slice(0, 1_200);
  return JSON.stringify({
    pendingTimers: clock?.timerHeap?.timers.map(({ type, delay, callAt, createdAt, func }) => ({
      type,
      delay,
      callAt,
      createdAt,
      callback: callback(func),
    })),
    pendingJobs: clock?.jobs?.map(({ func }) => ({ callback: callback(func) })),
  });
}
