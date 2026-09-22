// Register call-through counters before storage owners evaluate.
// oxfmt-ignore
import { createCatalogIoCounters } from "./session-catalog.performance-counters.test-support.js";
import type { HeapProfiler, Profiler } from "node:inspector";
import { Session as InspectorSession } from "node:inspector/promises";
import { expect, it } from "vitest";
import type {
  SessionCatalogHost,
  SessionsCatalogListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createComposedCatalogFixture } from "./session-catalog.performance.test-support.js";

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
  let catalogPreviewSamples = 0;
  let sanitizeTerminalTextSamples = 0;
  const samples = profile.samples ?? [];
  for (const id of samples) {
    if (namesById.get(id) === "catalogPreview") {
      catalogPreviewSamples++;
    }
    if (namesById.get(id) === "sanitizeTerminalText") {
      sanitizeTerminalTextSamples++;
    }
  }
  return { totalCpuSamples: samples.length, catalogPreviewSamples, sanitizeTerminalTextSamples };
}

it("measures 100 composed catalog lists against real session and plugin stores", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "composed-catalog-" },
    async (state) => {
      const counters = createCatalogIoCounters();
      let fixture: Awaited<ReturnType<typeof createComposedCatalogFixture>> | undefined;
      try {
        counters.begin();
        fixture = await createComposedCatalogFixture(state, counters);
        const first = await fixture.list();
        expect(first.sessions.length).toBeGreaterThan(0);
        const sourceHomeId = first.sessions[0]?.sourceHomeId;
        if (!sourceHomeId) {
          throw new Error("Native catalog did not expose its source home identity");
        }
        let page = await fixture.list();
        let visibleCount = page.sessions.length;
        while (page.nextCursor) {
          page = await fixture.list({ cursors: { [page.hostId]: page.nextCursor } });
          visibleCount += page.sessions.length;
        }
        expect(visibleCount).toBe(3_000);
        const snapshot = fixture.api.runtime.state.openKeyedStore<{
          version: number;
          kind: string;
        }>({
          namespace: await counters.catalogPersisted,
          maxEntries: 20_001,
          overflowPolicy: "reject-new",
        });
        expect(await snapshot.lookup("complete")).toEqual({ version: 1, kind: "complete" });
        const setupIo = counters.end();
        expect(setupIo.nativeRpcCalls).toBeGreaterThan(0);
        expect(setupIo.nativeThreadListCalls).toBeGreaterThan(0);
        expect(setupIo.sqliteReadCalls).toBeGreaterThan(0);
        expect(setupIo.sessionEntryReads).toBeGreaterThan(0);
        expect(setupIo.fileReadCalls).toBeGreaterThan(0);
        expect(setupIo.pluginStateWorkerReadOperations).toBeGreaterThan(0);

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
        const head = await fixture.list();
        expect(head.sessions.filter((session) => session.sessionKey)).toHaveLength(3);
        const search = await fixture.list({ search: "Project 7", limitPerHost: 32 });
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
            const result = await fixture.list(query);
            if (warm === 2) {
              warmResponses.push(result);
            }
          }
        }
        do {
          await fixture.projection.ensureMaterialized();
        } while (fixture.projection.needsMaterialization);
        const cpuReferenceP50Ms = measureHostCpuReference();
        expect(fixture.setupMaintenance).toEqual({ started: 3, completed: 3 });
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
          workPerList.push({
            sqliteReadCalls: currentIo.sqliteReadCalls - previousIo.sqliteReadCalls,
            bindingAuthorityReads:
              currentIo.bindingAuthorityReads - previousIo.bindingAuthorityReads,
            pluginStateWorkerOperations:
              currentIo.pluginStateWorkerOperations - previousIo.pluginStateWorkerOperations,
          });
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
        expect(fixture.setupMaintenance).toEqual({ started: 3, completed: 3 });
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
            ioPerList: Object.fromEntries(
              Object.entries(io).map(([key, value]) => [key, value / 100]),
            ),
            scope:
              "Explicit local Codex host through Gateway request admission, registered provider, session accessor and plugin stores. Main-thread SQL counts include freshness and binding authority reads; worker read operations are reported separately. File counts cover sync, callback and promise fs read/open APIs.",
          }),
        );
        expect(cpuSamples.totalCpuSamples).toBeGreaterThan(0);
        expect(cpuSamples.catalogPreviewSamples).toBe(0);
        expect(cpuSamples.sanitizeTerminalTextSamples).toBe(0);
        expect(io.nativeRpcCalls).toBe(0);
        expect(io.fileReadCalls).toBe(0);
        expect(io.fileOpenCalls).toBe(0);
        expect(io.pluginStateWorkerReadOperations).toBe(0);
        expect(io.sessionEntryReads).toBe(0);
        expect(io.sessionPayloadReads).toBe(0);
        // The adopted cohort shares one freshness, schema-admission, and authority read path.
        for (const work of workPerList) {
          expect(work).toEqual({
            sqliteReadCalls: 6,
            bindingAuthorityReads: 1,
            pluginStateWorkerOperations: 0,
          });
        }
        // Two-CPU reference 1.568–1.615 ms gives 31.36–32.30 ms: >3x the prior 9.43 ms
        // main median, below 10x the fastest 3.479 ms list. CPU-scaling the 23.95 ms
        // hosted sighting predicts ~79.7 ms. Without an independent bound, uniform
        // composition CPU growth leaves exact SQL budgets green.
        expect(durations[49]).toBeLessThan(cpuReferenceP50Ms * 20);
      } finally {
        try {
          await fixture?.close();
        } finally {
          counters.close();
        }
      }
    },
  );
});
