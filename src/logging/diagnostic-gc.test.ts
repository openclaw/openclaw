import { once } from "node:events";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import { emitDiagnosticMemorySample } from "./diagnostic-memory.js";
import { startGatewayDiagnosticHeartbeat, stopGatewayDiagnosticHeartbeat } from "./diagnostic.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

const native = vi.hoisted(() => {
  type Collection = {
    gcType: string;
    cost: number;
    beforeGC?: { heapStatistics: { usedHeapSize: number } };
    afterGC?: {
      heapStatistics?: { usedHeapSize: number };
      heapSpaceStatistics: { spaceName: string; spaceUsedSize: number }[];
    };
  };
  const active = new Set<Profiler>();
  class Profiler {
    collections: Collection[] = [];
    start() {
      this.collections = [];
      active.add(this);
    }
    stop() {
      active.delete(this);
      return {
        statistics: this.collections.map((entry) => ({
          ...entry,
          beforeGC: entry.beforeGC ?? { heapStatistics: { usedHeapSize: 0 } },
          afterGC: {
            heapStatistics: { usedHeapSize: 0 },
            heapSpaceStatistics: [],
            ...entry.afterGC,
          },
        })),
      };
    }
  }
  return {
    Profiler,
    active,
    collect(collections: Collection[]) {
      for (const profiler of active) {
        profiler.collections.push(...collections);
      }
    },
  };
});

vi.mock("node:v8", async (original) => ({
  ...(await original<typeof import("node:v8")>()),
  GCProfiler: native.Profiler,
}));

const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");

beforeEach(() => {
  // The native profiler fixture exercises Node behavior even when Vitest runs on Bun.
  Object.defineProperty(process.versions, "bun", { configurable: true, value: undefined });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

it("drains final short-task GC on retirement without sampling each task or counting a batch twice", async () => {
  const parent = new MessageChannel();
  const attached = once(parent.port1, "message");
  const memory = serveWorkerMemorySamples(parent.port2);
  const [{ port }] = (await attached) as [{ port: MessagePort }];
  await once(port, "message");
  const samples: unknown[] = [];
  port.on("message", (sample) => samples.push(sample));
  const flush = () =>
    new Promise<void>((resolve) => {
      const receive = (sample: { flushed?: boolean }) => {
        if (sample.flushed) {
          port.off("message", receive);
          resolve();
        }
      };
      port.on("message", receive);
      port.postMessage({ flush: true });
    });
  try {
    memory.setTaskMetrics(true);
    native.collect([
      {
        gcType: "Scavenge",
        cost: 2_000,
        beforeGC: { heapStatistics: { usedHeapSize: 2048 } },
        afterGC: { heapStatistics: { usedHeapSize: 512 }, heapSpaceStatistics: [] },
      },
    ]);
    expect(memory.collectTask()).toBe(true);
    await vi.advanceTimersByTimeAsync(900);
    expect(samples).toEqual([]);
    await flush();
    expect(samples).toContainEqual({
      gc: [
        {
          kind: "scavenge",
          reason: "other",
          durationMs: 2,
          heapUsedBeforeBytes: 2048,
          reclaimedBytes: 1536,
        },
      ],
    });
    samples.length = 0;
    await flush();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ flushed: true });
    expect(samples[0]).not.toHaveProperty("gc");
    memory.setTaskMetrics(false);
    expect(memory.collectTask()).toBeUndefined();
  } finally {
    memory.close();
    port.close();
    parent.port1.close();
    parent.port2.close();
  }
});

afterEach(() => {
  resetDiagnosticStateForTest();
  resetDiagnosticEventsForTest();
  native.active.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (bunVersion) {
    Object.defineProperty(process.versions, "bun", bunVersion);
  } else {
    Reflect.deleteProperty(process.versions, "bun");
  }
});

it("owns demand, sampled GC batches, and disable/re-enable through the existing heartbeat", async () => {
  const clock = createGatewaySchedulerClock(0);
  const scheduler = createTestGatewayScheduler(clock.clock);
  const observations: unknown[] = [];
  const start = () =>
    startGatewayDiagnosticHeartbeat(scheduler, {}, { sampleLiveness: () => null });
  const publicUnsubscribe = onDiagnosticEvent(() => {});
  let unsubscribe = () => {};
  try {
    setDiagnosticsEnabledForProcess(false);
    start();
    expect(native.active.size).toBe(0);
    setDiagnosticsEnabledForProcess(true);
    start();
    expect(hasInternalDiagnosticEventInterest("diagnostic.gc")).toBe(false);
    expect(native.active.size).toBe(0);

    unsubscribe = onInternalDiagnosticEvent(
      (event) => {
        if (event.type === "diagnostic.gc") {
          observations.push([event.kind, event.thread, event.durationMs]);
        }
      },
      { include: ["diagnostic.gc"] },
    );
    await clock.advanceBy(29_999);
    expect(native.active.size).toBe(0);
    await clock.advanceBy(1);
    expect(native.active.size).toBe(1);
    start();
    expect(native.active.size).toBe(1);
    native.collect([
      { gcType: "Scavenge", cost: 10_000 },
      { gcType: "MarkSweepCompact", cost: 20_000 },
      { gcType: "IncrementalMarking", cost: 2_000 },
      { gcType: "ProcessWeakCallbacks", cost: 3_000 },
      { gcType: "Unknown", cost: 99_000 },
    ]);
    await waitForDiagnosticEventsDrained();
    expect(observations).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForDiagnosticEventsDrained();
    expect(observations).toEqual([
      ["scavenge", "main", 10],
      ["mark_sweep_compact", "main", 20],
      ["incremental", "main", 2],
      ["weak_processing", "main", 3],
    ]);

    setDiagnosticsEnabledForProcess(false);
    native.collect([{ gcType: "Scavenge", cost: 99_000 }]);
    start();
    expect(native.active.size).toBe(0);
    setDiagnosticsEnabledForProcess(true);
    start();
    native.collect([{ gcType: "Scavenge", cost: 30_000 }]);
    await vi.advanceTimersByTimeAsync(1_000);
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
    expect(native.active.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    stopGatewayDiagnosticHeartbeat();
  } finally {
    unsubscribe();
    publicUnsubscribe();
    await scheduler.stop();
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
  const heaps: unknown[] = [];
  const unsubscribe = onInternalDiagnosticEvent(
    (event) => {
      if (event.type === "diagnostic.gc" && event.thread !== "main") {
        events.push([event.kind, event.thread, event.durationMs, event.workerSlot]);
        if (event.kind === "mark_sweep_compact") {
          heaps.push([event.heapUsedAfterMajorGcBytes, event.heapUsedAfterMajorGcTimestampSeconds]);
        }
      }
    },
    { include: ["diagnostic.gc"] },
  );
  setDiagnosticsEnabledForProcess(true);
  reconcileDiagnosticGcObserver();
  const attached = once(parent.port1, "message");
  const { close } = serveWorkerMemorySamples(parent.port2);
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
    // Both services run in this test isolate and share the native sampler.
    expect(native.active.size).toBe(1);
    const messages: unknown[] = [];
    telemetry!.on("message", (sample) => messages.push(sample));
    native.collect([
      { gcType: "Scavenge", cost: 2_000 },
      { gcType: "MarkSweepCompact", cost: 8_000 },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await fence();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ heapUsed: expect.any(Number) });
    await waitForDiagnosticEventsDrained();
    expect(events).toEqual([
      ["scavenge", `${script}.js`, 2, slot],
      ["mark_sweep_compact", `${script}.js`, 8, slot],
    ]);
    expect(heaps).toEqual([[0, expect.any(Number)]]);
    events.length = 0;
    messages.length = 0;
    const flushed = once(telemetry!, "message");
    const batch = Array.from({ length: 128 }, () => ({
      gcType: "Scavenge",
      cost: 1_000,
    }));
    native.collect(batch);
    native.collect(batch);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushed;
    await waitForDiagnosticEventsDrained();
    expect(messages).toEqual([
      {
        gc: Array.from({ length: 256 }, () => ({
          kind: "scavenge",
          reason: "other",
          durationMs: 1,
          heapUsedBeforeBytes: 0,
          reclaimedBytes: 0,
        })),
      },
    ]);
    expect(events).toEqual(
      Array.from({ length: 256 }, () => ["scavenge", `${script}.js`, 1, slot]),
    );
    events.length = 0;
    setDiagnosticsEnabledForProcess(false);
    stopDiagnosticGcObserver();
    await fence();
    expect(native.active.size).toBe(0);
    native.collect([{ gcType: "Scavenge", cost: 99_000 }]);
    setDiagnosticsEnabledForProcess(true);
    reconcileDiagnosticGcObserver();
    await fence();
    expect(native.active.size).toBe(1);
    native.collect([{ gcType: "Scavenge", cost: 7_000 }]);
    const closed = once(telemetry!, "close");
    close();
    await closed;
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
        labels.push([event.kind, event.thread, event.workerSlot, event.reason]);
      }
    },
    { include: ["diagnostic.gc"] },
  );
  // JavaScript SDK producers are not constrained by the TypeScript kind union.
  for (const fields of JSON.parse(`[
    {"kind":"scavenge","thread":"main","reason":"forced"},
    {"kind":"mark_sweep_compact","thread":"sqlite-store.worker.js","reason":"all_external_memory"},
    {"kind":"dynamic-123","thread":"worker-123","reason":"private-user-reason"},
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
    ["scavenge", "main", undefined, "forced"],
    ["mark_sweep_compact", "sqlite-store.worker.js", undefined, "all_external_memory"],
    [undefined, "other", undefined, "other"],
    [undefined, "other", undefined, "other"],
    [undefined, "main", undefined, "other"],
    [undefined, "code-mode-node.worker.js", 1, "other"],
    [undefined, "code-mode-node.worker.js", 64, "other"],
    [undefined, "code-mode-node.worker.js", undefined, "other"],
    [undefined, "code-mode-node.worker.js", undefined, "other"],
    [undefined, "code-mode-node.worker.js", undefined, "other"],
    [undefined, "code-mode-node.worker.js", undefined, "other"],
    [undefined, "main", undefined, "other"],
  ]);
});

it("reports native major-GC heap bytes and observation time without sampling scavenges", async () => {
  const samples: unknown[] = [];
  const unsubscribe = onInternalDiagnosticEvent(
    (event) => {
      if (event.type === "diagnostic.gc") {
        samples.push([
          event.reason,
          event.heapUsedAfterMajorGcBytes,
          event.heapUsedAfterMajorGcTimestampSeconds,
        ]);
      }
    },
    { include: ["diagnostic.gc"] },
  );
  setDiagnosticsEnabledForProcess(true);
  reconcileDiagnosticGcObserver();
  try {
    vi.spyOn(Date, "now").mockReturnValue(1700000000123);
    native.collect([
      {
        gcType: "MarkSweepCompact",
        cost: 1_000,
        afterGC: { heapStatistics: { usedHeapSize: 512 }, heapSpaceStatistics: [] },
      },
      { gcType: "Scavenge", cost: 1_000 },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForDiagnosticEventsDrained();
    expect(samples).toEqual([
      ["other", 512, 1700000000.123],
      ["other", undefined, undefined],
    ]);
  } finally {
    stopDiagnosticGcObserver();
    unsubscribe();
  }
});

it("retains the native post-major-GC baseline across allocations and clears it on stop", async () => {
  const sampleMain = () =>
    emitDiagnosticMemorySample({
      isBunRuntime: false,
      heapSizeLimitBytes: 10_000,
      memoryUsage: { rss: 1000, heapUsed: 600, heapTotal: 1000, external: 100, arrayBuffers: 50 },
    });
  const unsubscribe = onInternalDiagnosticEvent(() => {}, { include: ["diagnostic.gc"] });
  setDiagnosticsEnabledForProcess(true);
  reconcileDiagnosticGcObserver();
  const parent = new MessageChannel();
  const attached = once(parent.port1, "message");
  const { close } = serveWorkerMemorySamples(parent.port2);
  const [{ port }] = (await attached) as [{ port: MessagePort }];
  try {
    await once(port, "message");
    port.postMessage({ gc: true });
    const sample = async () => {
      const pending = once(port, "message");
      port.postMessage(undefined);
      return (await pending)[0] as { oldGenerationAfterGcBytes?: number };
    };
    expect((await sample()).oldGenerationAfterGcBytes).toBeUndefined();
    expect(sampleMain().oldGenerationAfterGcBytes).toBeUndefined();
    const collection = (gcType: string, old: number) => ({
      gcType,
      cost: 1_000,
      afterGC: {
        heapSpaceStatistics: [
          { spaceName: "old_space", spaceUsedSize: old },
          { spaceName: "large_object_space", spaceUsedSize: 200 },
          { spaceName: "new_space", spaceUsedSize: 9999 },
          { spaceName: "code_space", spaceUsedSize: 9999 },
        ],
      },
    });
    native.collect([
      collection("MarkSweepCompact", 100),
      collection("MarkSweepCompact", 300),
      collection("Scavenge", 900),
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    const memory = sampleMain();
    expect(memory).toMatchObject({ heapSizeLimitBytes: 10_000, oldGenerationAfterGcBytes: 500 });
    expect(await sample()).toMatchObject({ oldGenerationAfterGcBytes: 500 });
    native.collect([collection("Scavenge", 1234)]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await sample()).toMatchObject({ oldGenerationAfterGcBytes: 500 });
    stopDiagnosticGcObserver();
    close();
    expect(sampleMain().oldGenerationAfterGcBytes).toBeUndefined();
    reconcileDiagnosticGcObserver();
    expect(sampleMain().oldGenerationAfterGcBytes).toBeUndefined();
  } finally {
    close();
    stopDiagnosticGcObserver();
    unsubscribe();
    port.close();
    parent.port1.close();
    parent.port2.close();
  }
});
