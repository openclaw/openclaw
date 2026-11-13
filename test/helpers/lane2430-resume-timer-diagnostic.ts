import { vi } from "vitest";

export function traceResumeTimerRegistrations() {
  const timeout = globalThis.setTimeout;
  const interval = globalThis.setInterval;
  const immediate = globalThis.setImmediate;
  const clock: unknown = Reflect.get(timeout, "clock");
  const registrations: Array<{ kind: string; id: number; locations: string[] }> = [];
  let registrationCount = 0;
  const record = (kind: string, id: number) => {
    registrationCount += 1;
    if (registrations.length === 64) {
      registrations.shift();
    }
    const locations = [
      ...(new Error().stack ?? "").matchAll(/\/(src|test|packages)\/([^\s():]+):(\d+):(\d+)/g),
    ]
      .map((match) => `${match[1]}/${match[2]}:${match[3]}:${match[4]}`.slice(0, 240))
      .filter((path) => !path.startsWith("test/helpers/lane2430-resume-timer-diagnostic.ts:"))
      .slice(0, 4);
    registrations.push({ kind, id, locations });
  };
  const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((...args) => {
    const id = timeout(...args);
    record("timeout", Number(id));
    return id;
  });
  const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((...args) => {
    const id = interval(...args);
    record("interval", Number(id));
    return id;
  });
  const immediateSpy = vi.spyOn(globalThis, "setImmediate").mockImplementation((...args) => {
    const id = immediate(...args);
    record("immediate", Number(id));
    return id;
  });
  const field = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  return {
    [Symbol.dispose]() {
      const actual = vi.getTimerCount();
      if (actual !== 0) {
        const heap = field(field(clock, "timerHeap"), "timers");
        const jobs = field(clock, "jobs");
        const ids = Array.isArray(heap)
          ? heap
              .slice(0, 16)
              .map((timer) => field(timer, "id"))
              .filter((id) => typeof id === "number")
          : [];
        console.error(
          "[resume-timer-diagnostic]",
          JSON.stringify({
            actual,
            heapCount: Array.isArray(heap) ? heap.length : null,
            jobCount: Array.isArray(jobs) ? jobs.length : 0,
            ids,
            registrationCount,
            registrations,
          }),
        );
      }
      immediateSpy.mockRestore();
      intervalSpy.mockRestore();
      timeoutSpy.mockRestore();
    },
  };
}
