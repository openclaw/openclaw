// Register call-through counters before storage owners evaluate.
// oxfmt-ignore
import { createCatalogIoCounters } from "./session-catalog.performance-counters.test-support.js";
import type { Profiler } from "node:inspector";
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
  const durations = Array.from({ length: 26 }, () => {
    const started = performance.now();
    let checksum = 0x811c9dc5;
    for (let pass = 0; pass < 8; pass++) {
      for (const byte of bytes) {
        checksum = Math.imul(checksum ^ byte, 0x01000193) >>> 0;
      }
    }
    const duration = performance.now() - started;
    expect(checksum).toBe(2_398_395_845);
    return duration;
  }).slice(5);
  const median = durations.toSorted((a, b) => a - b)[10];
  if (median === undefined || median <= 0) {
    throw new Error("Expected a positive host CPU reference median");
  }
  return median;
}

function expectNoPreviewSamples(profile: Profiler.Profile) {
  const namesById = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
  const samples = (profile.samples ?? []).map((id) => namesById.get(id));
  expect(samples.length).toBeGreaterThan(0);
  expect(samples).not.toContain("catalogPreview");
  expect(samples).not.toContain("sanitizeTerminalText");
}

it("keeps 100 composed catalog lists within CPU and I/O budgets against real stores", () =>
  withOpenClawTestState({ layout: "state-only", prefix: "composed-catalog-" }, async (state) => {
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
      const complete = { version: 1, kind: "complete" };
      const snapshot = fixture.api.runtime.state.openKeyedStore<typeof complete>({
        namespace: catalogNamespace,
        maxEntries: 20_001,
        overflowPolicy: "reject-new",
      });
      expect(await snapshot.lookup("complete")).toEqual(complete);
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
        const adopted = await fixture.continueSession(first.hostId, thread.threadId, sourceHomeId);
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
        await fixture.setupList(query);
        await fixture.setupList(query);
        warmResponses.push(await fixture.setupList(query));
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
      }
      const io = counters.end();
      for (const [index, result] of measuredResponses.entries()) {
        expect(result).toEqual(warmResponses[index % variants.length]);
        expect(result.sessions.length).toBeGreaterThan(0);
      }
      durations.sort((a, b) => a - b);

      const inspector = new InspectorSession();
      expect(fixture.setupMaintenance).toEqual({ completed: 3 });
      inspector.connect();
      try {
        await inspector.post("HeapProfiler.collectGarbage");
        await inspector.post("Profiler.enable");
        await inspector.post("Profiler.start");
        for (let index = 0; index < 100; index++) {
          await fixture.list(variants[index % variants.length]);
        }
        const { profile: cpuProfile } = await inspector.post("Profiler.stop");
        expectNoPreviewSamples(cpuProfile);
      } finally {
        inspector.disconnect();
      }
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
  }));
