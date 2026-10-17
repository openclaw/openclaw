// Register call-through counters before storage owners evaluate.
// oxfmt-ignore
import { createCatalogIoCounters } from "./session-catalog.performance-counters.test-support.js";
import type { HeapProfiler, Profiler } from "node:inspector";
import { Session as InspectorSession } from "node:inspector/promises";
import { expect, it, vi } from "vitest";
import type {
  SessionCatalogHost,
  SessionsCatalogListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createComposedCatalogFixture } from "./session-catalog.performance.test-support.js";

const workKeys = [
  "sqliteReadCalls",
  "sqliteFreshnessReads",
  "bindingAuthorityReads",
  "fileReadCalls",
  "ownershipFileReadCalls",
  "fileOpenCalls",
  "ownershipFileOpenCalls",
  "pluginStateWorkerOperations",
] as const;
const expectedWork = Object.fromEntries(
  workKeys.map((key) => [key, key === "pluginStateWorkerOperations" ? 1 : 0]),
);

function measureHostCpuReference(): number {
  const bytes = Uint8Array.from({ length: 65_536 }, (_, index) => index & 255);
  const hash = () => {
    let checksum = 0x811c9dc5;
    for (let pass = 0; pass < 8; pass++) {
      for (const byte of bytes) {
        checksum = Math.imul(checksum ^ byte, 0x01000193) >>> 0;
      }
    }
    return checksum;
  };
  const durations: number[] = [];
  for (let sample = 0; sample < 26; sample++) {
    const started = performance.now();
    const checksum = hash();
    const duration = performance.now() - started;
    expect(checksum).toBe(2_398_395_845);
    if (sample >= 5) {
      durations.push(duration);
    }
  }
  const median = durations.toSorted((a, b) => a - b)[10];
  if (median === undefined || median <= 0) {
    throw new Error("Expected a positive host CPU reference median");
  }
  return median;
}

function allocatedBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + allocatedBytes(child), 0);
}

function observedCpuSamples(profile: Profiler.Profile) {
  const namesById = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
  const samples = profile.samples ?? [];
  const count = (name: string) => samples.filter((id) => namesById.get(id) === name).length;
  return {
    totalCpuSamples: samples.length,
    catalogPreviewSamples: count("catalogPreview"),
    sanitizeTerminalTextSamples: count("sanitizeTerminalText"),
  };
}

it("measures 100 composed catalog lists against real session and plugin stores", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "composed-catalog-" },
    async (state) => {
      const counters = createCatalogIoCounters();
      const nativeListEntered = createDeferredCore();
      const releaseNativeList = createDeferredCore();
      let fixture: Awaited<ReturnType<typeof createComposedCatalogFixture>> | undefined;
      try {
        counters.begin();
        fixture = await createComposedCatalogFixture(state, counters, {
          beforeNativeListResponse: async () => {
            nativeListEntered.resolve();
            await releaseNativeList.promise;
          },
        });
        let first: SessionCatalogHost;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const ready = fixture.setupList();
          // Observe early rejection while the native producer is deliberately held.
          void ready.catch(() => {});
          await nativeListEntered.promise;
          // Cold callers expire after five seconds without cancelling index-owned hydration.
          await vi.advanceTimersByTimeAsync(5_000);
          vi.useRealTimers();
          releaseNativeList.resolve();
          first = await ready;
        } finally {
          vi.useRealTimers();
          releaseNativeList.resolve();
        }
        const catalogNamespace = await counters.catalogPersisted;
        expect(first.sessions.length).toBeGreaterThan(0);
        const sourceHomeId = first.sessions[0]?.sourceHomeId;
        if (!sourceHomeId) {
          throw new Error("Native catalog did not expose its source home identity");
        }
        let page = await fixture.setupList();
        let visibleCount = page.sessions.length;
        while (page.nextCursor) {
          page = await fixture.setupList({ cursors: { [page.hostId]: page.nextCursor } });
          visibleCount += page.sessions.length;
        }
        expect(visibleCount).toBe(3_000);
        const snapshot = fixture.api.runtime.state.openKeyedStore<{
          version: number;
          kind: string;
        }>({
          namespace: catalogNamespace,
          maxEntries: 20_001,
          overflowPolicy: "reject-new",
        });
        expect(await snapshot.lookup("complete")).toEqual({ version: 1, kind: "complete" });
        const setupIo = counters.end();
        for (const key of [
          "nativeRpcCalls",
          "nativeThreadListCalls",
          "sqliteReadCalls",
          "sessionEntryReads",
          "fileReadCalls",
          "pluginStateWorkerReadOperations",
        ] as const) {
          expect(setupIo[key], key).toBeGreaterThan(0);
        }

        for (const thread of first.sessions.slice(0, 3)) {
          const adopted = await fixture.continueSession(
            first.hostId,
            thread.threadId,
            sourceHomeId,
          );
          expect(adopted).toMatchObject({ sessionKey: expect.any(String) });
        }
        do {
          await fixture.projection.ensureMaterialized();
        } while (fixture.projection.needsMaterialization);
        const head = await fixture.setupList();
        expect(head.sessions.filter((session) => session.sessionKey)).toHaveLength(3);
        const search = await fixture.setupList({ search: "Project 7", limitPerHost: 32 });
        if (!head.nextCursor || !search.nextCursor) {
          throw new Error("Expected native continuation fixtures");
        }
        const variants: Array<Partial<SessionsCatalogListParams>> = [
          { limitPerHost: 64 },
          { search: "Project 7", limitPerHost: 32 },
          { cursors: { [head.hostId]: head.nextCursor }, limitPerHost: 64 },
          {
            search: "Project 7",
            cursors: { [search.hostId]: search.nextCursor },
            limitPerHost: 32,
          },
        ];
        const warmResponses: SessionCatalogHost[] = [];
        for (const query of variants) {
          for (let warm = 0; warm < 3; warm++) {
            const result = await fixture.setupList(query);
            if (warm === 2) {
              warmResponses.push(result);
            }
          }
        }
        do {
          await fixture.projection.ensureMaterialized();
        } while (fixture.projection.needsMaterialization);
        const cpuReferenceP50Ms = measureHostCpuReference();
        expect(fixture.setupMaintenance).toEqual({ completed: 3 });
        counters.begin();
        const durations: number[] = [];
        const workPerList = [];
        const measuredResponses: SessionCatalogHost[] = [];
        let previousIo = counters.snapshot();
        let minimumRows = Infinity;
        const cpuStart = process.threadCpuUsage();
        for (let index = 0; index < 100; index++) {
          const started = performance.now();
          const result = await fixture.list(variants[index % variants.length]);
          durations.push(performance.now() - started);
          measuredResponses.push(result);
          const currentIo = counters.snapshot();
          workPerList.push(
            Object.fromEntries(workKeys.map((key) => [key, currentIo[key] - previousIo[key]])),
          );
          previousIo = currentIo;
          minimumRows = Math.min(minimumRows, result.sessions.length);
        }
        const cpu = process.threadCpuUsage(cpuStart);
        const io = counters.end();
        for (const [index, result] of measuredResponses.entries()) {
          expect(result).toEqual(warmResponses[index % variants.length]);
        }
        expect(minimumRows).toBeGreaterThan(0);
        durations.sort((a, b) => a - b);

        const inspector = new InspectorSession();
        expect(fixture.setupMaintenance).toEqual({ completed: 3 });
        inspector.connect();
        let sampledAllocationBytes: number;
        let cpuSamples: ReturnType<typeof observedCpuSamples>;
        try {
          await inspector.post("HeapProfiler.collectGarbage");
          await inspector.post("Profiler.enable");
          await inspector.post("Profiler.start");
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 32 * 1024,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
          for (let index = 0; index < 100; index++) {
            await fixture.list(variants[index % variants.length]);
          }
          const { profile: heapProfile } = await inspector.post("HeapProfiler.stopSampling");
          const { profile: cpuProfile } = await inspector.post("Profiler.stop");
          sampledAllocationBytes = allocatedBytes(heapProfile.head);
          cpuSamples = observedCpuSamples(cpuProfile);
        } finally {
          inspector.disconnect();
        }
        console.info(
          "composed resident catalog measurements",
          JSON.stringify({
            nativeRows: 3_000,
            localRows: 3_000,
            adoptedRows: 3,
            lists: 100,
            p50Ms: durations[49],
            cpuReferenceP50Ms,
            p95Ms: durations[94],
            threadCpuMsPerList: (cpu.user + cpu.system) / 100_000,
            sampledInstrumentedAllocationBytesPerList: sampledAllocationBytes / 100,
            observedCpuSamples: cpuSamples,
            profilingScope:
              "Separate 100-list pass with CPU and heap sampling. Counts are observed self samples; zero samples cannot exclude calls shorter than the sampling interval.",
            setupIo,
            ioTotals: io,
            workPerList,
            scope:
              "Explicit local Codex host through Gateway request admission, registered provider, session accessor and plugin stores. Each sample joins its final host publication and tracked provider refresh. Binding authority is acquired through the plugin-state worker; calling-thread SQL and worker operations are counted separately. File counts cover sync, callback and promise fs read/open APIs, including separately attributed live ownership checks. Descriptor classification adds fstat instrumentation cost.",
          }),
        );
        expect(cpuSamples.totalCpuSamples).toBeGreaterThan(0);
        expect(cpuSamples).toMatchObject({
          catalogPreviewSamples: 0,
          sanitizeTerminalTextSamples: 0,
        });
        expect(io.fileReadCalls).toBe(io.ownershipFileReadCalls);
        expect(io.fileOpenCalls).toBe(io.ownershipFileOpenCalls);
        expect(io).toMatchObject({
          nativeRpcCalls: 0,
          pluginStateWorkerReadOperations: 100,
          sessionEntryReads: 0,
          sessionPayloadReads: 0,
        });
        // Binding authority stays in the worker; warm reads reuse process-owned admission.
        for (const work of workPerList) {
          expect(work).toEqual(expectedWork);
        }
        // Scale the latency budget to host CPU; SQL budgets alone miss composition CPU growth.
        expect(durations[49]).toBeLessThan(cpuReferenceP50Ms * 20);
      } finally {
        vi.useRealTimers();
        releaseNativeList.resolve();
        try {
          await fixture?.close();
        } finally {
          counters.close();
        }
      }
    },
  );
});
