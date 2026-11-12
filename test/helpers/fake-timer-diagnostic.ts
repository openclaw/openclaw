import { vi } from "vitest";

// Temporary proof-only instrumentation for lane 2430's unattributed timer census failures.
export function traceFakeTimerDiagnostics(label: string) {
  const originalTimeout = globalThis.setTimeout;
  const originalInterval = globalThis.setInterval;
  const originalImmediate = globalThis.setImmediate;
  const clock: unknown = Reflect.get(originalTimeout, "clock");
  const registrations: Array<{
    kind: string;
    id: number;
    delay?: number;
    locations: string[];
  }> = [];
  let omittedRegistrations = 0;
  const record = (kind: string, id: number, delay?: number) => {
    if (registrations.length >= 64) {
      omittedRegistrations += 1;
      return;
    }
    const locations = [
      ...(new Error().stack ?? "").matchAll(/\/(src|test|packages)\/([^\s():]+):(\d+):(\d+)/g),
    ]
      .map((match) => `${match[1]}/${match[2]}:${match[3]}:${match[4]}`)
      .filter((location) => !location.startsWith("test/helpers/fake-timer-diagnostic.ts:"))
      .slice(0, 4)
      .map((location) => location.slice(0, 240));
    registrations.push({ kind, id, delay, locations });
  };
  const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((...args) => {
    const timer = originalTimeout(...args);
    record("timeout", Number(timer), args[1]);
    return timer;
  });
  const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((...args) => {
    const timer = originalInterval(...args);
    record("interval", Number(timer), args[1]);
    return timer;
  });
  const immediateSpy = vi.spyOn(globalThis, "setImmediate").mockImplementation((...args) => {
    const timer = originalImmediate(...args);
    record("immediate", Number(timer));
    return timer;
  });
  const field = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  const numberField = (value: unknown, key: string) => {
    const result = field(value, key);
    return typeof result === "number" && Number.isFinite(result) ? result : undefined;
  };
  return {
    reportIfUnexpected(expected: number) {
      const actual = vi.getTimerCount();
      if (actual === expected) {
        return;
      }
      const heap = field(field(clock, "timerHeap"), "timers");
      const jobs = field(clock, "jobs");
      console.error(
        "[fake-timer-diagnostic]",
        JSON.stringify({
          label,
          expected,
          actual,
          heapCount: Array.isArray(heap) ? heap.length : undefined,
          jobCount: Array.isArray(jobs) ? jobs.length : 0,
          timers: Array.isArray(heap)
            ? heap.slice(0, 16).map((timer) => ({
                id: numberField(timer, "id"),
                delay: numberField(timer, "delay"),
                createdAt: numberField(timer, "createdAt"),
                callAt: numberField(timer, "callAt"),
              }))
            : undefined,
          registrations,
          omittedRegistrations,
        }),
      );
    },
    [Symbol.dispose]() {
      immediateSpy.mockRestore();
      intervalSpy.mockRestore();
      timeoutSpy.mockRestore();
    },
  };
}
