import { once } from "node:events";
import { performance, constants } from "node:perf_hooks";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { hasInternalDiagnosticEventInterest } from "../infra/diagnostic-event-listener-presence.js";
import {
  emitTrustedDiagnosticEvent,
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  createCpuTrackedWorker,
  receiveWorkerMemoryPort,
  trackNativeWorkerForCpu,
} from "../infra/worker-cpu.js";
import { serveWorkerMemorySamples } from "../infra/worker-memory.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { reconcileDiagnosticGcObserver, stopDiagnosticGcObserver } from "./diagnostic-gc.js";
import { startGatewayDiagnosticHeartbeat, stopGatewayDiagnosticHeartbeat } from "./diagnostic.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

const native = vi.hoisted(() => {
  type Entry = { startTime: number; duration: number; detail?: { kind: number } };
  const observers: Observer[] = [];
  class Observer {
    static supportedEntryTypes = ["gc"];
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(private callback: (list: { getEntries: () => Entry[] }) => void) {
      observers.push(this);
    }
    deliver(entries: Entry[]) {
      this.callback({
        getEntries: () => entries.map((entry) => ({ detail: { kind: 1 }, ...entry })),
      });
    }
  }
  return { Observer, observers };
});

vi.mock("node:perf_hooks", async (original) => ({
  ...(await original<typeof import("node:perf_hooks")>()),
  PerformanceObserver: native.Observer,
}));

afterEach(() => {
  resetDiagnosticStateForTest();
  resetDiagnosticEventsForTest();
  native.observers.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("owns demand, queued GC batches, and disable/re-enable through the existing heartbeat", async () => {
  const clock = createGatewaySchedulerClock(0);
  const scheduler = createTestGatewayScheduler(clock.clock);
  const now = vi.spyOn(performance, "now").mockReturnValue(100);
  const observations: unknown[] = [];
  const start = () =>
    startGatewayDiagnosticHeartbeat(scheduler, {}, { sampleLiveness: () => null });
  const publicUnsubscribe = onDiagnosticEvent(() => {});
  let unsubscribe = () => {};
  try {
    setDiagnosticsEnabledForProcess(false);
    start();
    expect(native.observers).toHaveLength(0);
    setDiagnosticsEnabledForProcess(true);
    start();
    expect(hasInternalDiagnosticEventInterest("diagnostic.gc")).toBe(false);
    expect(native.observers).toHaveLength(0);

    unsubscribe = onInternalDiagnosticEvent(
      (event) => {
        if (event.type === "diagnostic.gc") {
          observations.push([event.kind, event.thread, event.durationMs]);
        }
      },
      { include: ["diagnostic.gc"] },
    );
    await clock.advanceBy(29_999);
    expect(native.observers).toHaveLength(0);
    await clock.advanceBy(1);
    const first = native.observers[0]!;
    expect(first.observe).toHaveBeenCalledExactlyOnceWith({ entryTypes: ["gc"] });
    start();
    expect(native.observers).toHaveLength(1);
    first.deliver([
      { startTime: 99, duration: 99 },
      { startTime: 100, duration: 10 },
      { startTime: 101, duration: 20, detail: { kind: constants.NODE_PERFORMANCE_GC_MAJOR } },
      { startTime: 102, duration: 2, detail: { kind: constants.NODE_PERFORMANCE_GC_INCREMENTAL } },
      { startTime: 103, duration: 3, detail: { kind: constants.NODE_PERFORMANCE_GC_WEAKCB } },
      { startTime: 104, duration: 99, detail: { kind: 12345 } },
    ]);
    await waitForDiagnosticEventsDrained();
    expect(observations).toEqual([
      ["scavenge", "main", 10],
      ["mark_sweep_compact", "main", 20],
      ["incremental", "main", 2],
      ["weak_processing", "main", 3],
    ]);

    setDiagnosticsEnabledForProcess(false);
    first.deliver([{ startTime: 150, duration: 99 }]);
    stopGatewayDiagnosticHeartbeat();
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    now.mockReturnValue(200);
    setDiagnosticsEnabledForProcess(true);
    start();
    first.deliver([{ startTime: 201, duration: 99 }]);
    native.observers[1]!.deliver([
      { startTime: 199, duration: 99 },
      { startTime: 200, duration: 30 },
    ]);
    await waitForDiagnosticEventsDrained();
    expect(observations).toEqual([
      ["scavenge", "main", 10],
      ["mark_sweep_compact", "main", 20],
      ["incremental", "main", 2],
      ["weak_processing", "main", 3],
      ["scavenge", "main", 30],
    ]);

    unsubscribe();
    expect(hasInternalDiagnosticEventInterest("diagnostic.gc")).toBe(false);
    await clock.advanceBy(30_000);
    expect(native.observers[1]!.disconnect).toHaveBeenCalledTimes(1);
    stopGatewayDiagnosticHeartbeat();
    expect(native.observers[1]!.disconnect).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
    publicUnsubscribe();
  }
});

it.each([
  ["sqlite-store.worker.ts", "sqlite-store.worker", undefined],
  ["code-mode-node.worker.ts", "code-mode-node.worker", 1],
  ["code-mode-node.worker.mjs", "code-mode-node.worker", 1],
] as const)("batches %s GC and flushes at shutdown", async (file, script, slot) => {
  const worker = createCpuTrackedWorker(
    'require("node:worker_threads").parentPort.on("message", () => {});',
    { eval: true },
  );
  trackNativeWorkerForCpu(worker, new URL(`../infra/${file}`, import.meta.url));
  const parent = new MessageChannel();
  const events: unknown[] = [];
  const unsubscribe = onInternalDiagnosticEvent(
    (event) => {
      if (event.type === "diagnostic.gc") {
        events.push([event.kind, event.thread, event.durationMs, event.workerSlot]);
      }
    },
    { include: ["diagnostic.gc"] },
  );
  setDiagnosticsEnabledForProcess(true);
  reconcileDiagnosticGcObserver();
  const attached = once(parent.port1, "message");
  const close = serveWorkerMemorySamples(parent.port2);
  let telemetry: MessagePort | undefined;
  try {
    const [message] = await attached;
    telemetry = message.port;
    const initial = once(telemetry!, "message");
    expect(receiveWorkerMemoryPort(worker, message)).toBe(true);
    await initial;
    // A memory request/reply fences the preceding GC enablement message on this port.
    const fence = async () => {
      const sampled = once(telemetry!, "message");
      telemetry!.postMessage(undefined, []);
      await sampled;
    };
    await fence();
    expect(native.observers).toHaveLength(2);
    const workerObserver = native.observers[1]!;
    const messages: unknown[] = [];
    telemetry!.on("message", (sample) => messages.push(sample));
    workerObserver.deliver([{ startTime: performance.now(), duration: 2 }]);
    workerObserver.deliver([
      {
        startTime: performance.now(),
        duration: 8,
        detail: { kind: constants.NODE_PERFORMANCE_GC_MAJOR },
      },
    ]);
    await fence();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ heapUsed: expect.any(Number) });
    await waitForDiagnosticEventsDrained();
    expect(events).toEqual([
      ["scavenge", `${script}.js`, 2, slot],
      ["mark_sweep_compact", `${script}.js`, 8, slot],
    ]);
    events.length = 0;
    messages.length = 0;
    const flushed = once(telemetry!, "message");
    const batch = Array.from({ length: 128 }, () => ({
      startTime: performance.now(),
      duration: 1,
    }));
    workerObserver.deliver(batch);
    workerObserver.deliver(batch);
    await flushed;
    await waitForDiagnosticEventsDrained();
    expect(messages).toEqual([
      { gc: Array.from({ length: 256 }, () => ({ kind: "scavenge", durationMs: 1 })) },
    ]);
    expect(events).toEqual(
      Array.from({ length: 256 }, () => ["scavenge", `${script}.js`, 1, slot]),
    );
    events.length = 0;
    setDiagnosticsEnabledForProcess(false);
    stopDiagnosticGcObserver();
    await fence();
    expect(workerObserver.disconnect).toHaveBeenCalledTimes(1);
    workerObserver.deliver([{ startTime: performance.now(), duration: 99 }]);
    setDiagnosticsEnabledForProcess(true);
    reconcileDiagnosticGcObserver();
    await fence();
    expect(native.observers).toHaveLength(4);
    native.observers[3]!.deliver([{ startTime: performance.now(), duration: 7 }]);
    const closed = once(telemetry!, "close");
    close();
    await closed;
    expect(native.observers[3]!.disconnect).toHaveBeenCalled();
    await waitForDiagnosticEventsDrained();
    expect(events).toEqual([["scavenge", `${script}.js`, 7, slot]]);
  } finally {
    close();
    stopDiagnosticGcObserver();
    unsubscribe();
    parent.port1.close();
    parent.port2.close();
    await worker.terminate();
  }
});

it("bounds SDK GC attribution once before delivering it to metric consumers", async () => {
  const labels: unknown[] = [];
  onInternalDiagnosticEvent(
    (event) => {
      if (event.type === "diagnostic.gc") {
        labels.push([event.kind, event.thread, event.workerSlot]);
      }
    },
    { include: ["diagnostic.gc"] },
  );
  // JavaScript SDK producers are not constrained by the TypeScript kind union.
  for (const fields of JSON.parse(`[
    {"kind":"scavenge","thread":"main"},
    {"kind":"mark_sweep_compact","thread":"sqlite-store.worker.js"},
    {"kind":"dynamic-123","thread":"worker-123"},
    {"kind":"dynamic-456","thread":"/private/workers/job-456.js"},
    {},
    {"thread":"code-mode-node.worker.js","workerSlot":1},
    {"thread":"code-mode-node.worker.js","workerSlot":64},
    {"thread":"code-mode-node.worker.js","workerSlot":65},
    {"thread":"code-mode-node.worker.js","workerSlot":0},
    {"thread":"code-mode-node.worker.js","workerSlot":1.5},
    {"thread":"code-mode-node.worker.js","workerSlot":"1"},
    {"thread":"main","workerSlot":1}
  ]`)) {
    emitTrustedDiagnosticEvent({ type: "diagnostic.gc", durationMs: 1, ...fields });
  }
  await waitForDiagnosticEventsDrained();
  expect(labels).toEqual([
    ["scavenge", "main", undefined],
    ["mark_sweep_compact", "sqlite-store.worker.js", undefined],
    [undefined, "other", undefined],
    [undefined, "other", undefined],
    [undefined, "main", undefined],
    [undefined, "code-mode-node.worker.js", 1],
    [undefined, "code-mode-node.worker.js", 64],
    [undefined, "code-mode-node.worker.js", undefined],
    [undefined, "code-mode-node.worker.js", undefined],
    [undefined, "code-mode-node.worker.js", undefined],
    [undefined, "code-mode-node.worker.js", undefined],
    [undefined, "main", undefined],
  ]);
});
