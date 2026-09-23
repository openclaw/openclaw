import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { runWithDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as projectionAccess from "../session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import {
  hoisted,
  provider,
  resetSessionCatalogTestState,
  startCall,
} from "./session-catalog.test-helpers.js";

type Phase = Extract<DiagnosticEventPayload, { type: "diagnostic.phase.completed" }>;
const leaderTrace = { traceId: "11111111111111111111111111111111", spanId: "1111111111111111" };
const followerTrace = { traceId: "22222222222222222222222222222222", spanId: "2222222222222222" };
const privateText = "synthetic-private-catalog-content";
const host = {
  hostId: privateText,
  label: privateText,
  kind: "gateway" as const,
  connected: true,
  sessions: [],
};

describe("registered catalog list phase diagnostics", () => {
  let clock: number;
  let cpuMicros: number;
  let dirty: boolean;
  let config: { agents: { list: { id: string }[] } };
  let projection: ReturnType<typeof createSessionRowProjectionFixture>;
  let phases: Phase[];
  let trustedFlags: boolean[];
  let threadCpuUsage: MockInstance<typeof process.threadCpuUsage>;

  const observe = () =>
    onTrustedInternalDiagnosticEvent(
      (event, metadata) => {
        if (event.type === "diagnostic.phase.completed") {
          trustedFlags.push(metadata.trusted);
          phases.push(event);
        }
      },
      { include: ["diagnostic.phase.completed"] },
    );

  beforeEach(() => {
    resetSessionCatalogTestState();
    resetDiagnosticEventsForTest();
    clock = 0;
    cpuMicros = 0;
    dirty = false;
    phases = [];
    trustedFlags = [];
    config = { agents: { list: [{ id: "main" }] } };
    projection = createSessionRowProjectionFixture({ cfg: config, store: {} });
    Object.defineProperty(projection, "needsMaterialization", { get: () => dirty });
    vi.spyOn(projectionAccess, "getSessionRowProjection").mockReturnValue(projection);
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(Date, "now").mockImplementation(() => 1_700_000_000_000 + clock);
    threadCpuUsage = vi.spyOn(process, "threadCpuUsage").mockImplementation((previous) => ({
      user: cpuMicros - (previous?.user ?? 0),
      system: 0,
    }));
  });

  afterEach(async () => {
    await waitForDiagnosticEventsDrained();
    projection.dispose();
    resetDiagnosticEventsForTest();
    vi.restoreAllMocks();
  });

  it("separates projection and provider waits from synchronous planning and final response CPU", async () => {
    observe();
    const initial = createDeferredCore();
    const listing = createDeferredCore();
    const listed = createDeferredCore();
    const final = createDeferredCore();
    const finalStarted = createDeferredCore();
    dirty = true;
    vi.spyOn(projection, "ensureMaterialized")
      .mockImplementationOnce(async () => {
        await initial.promise;
        dirty = false;
      })
      .mockImplementationOnce(async () => {
        finalStarted.resolve();
        await final.promise;
        dirty = false;
      });
    vi.spyOn(projection, "selectEntries").mockImplementation(() => {
      clock += 2;
      cpuMicros += 1_000;
      return [];
    });
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider(privateText, {
          list: async () => {
            listed.resolve();
            await listing.promise;
            dirty = true;
            return [host];
          },
        }),
      },
    ];
    const call = runWithDiagnosticTraceContext(leaderTrace, () =>
      startCall("sessions.catalog.list", {}, config),
    );
    call.respond.mockImplementation(() => {
      clock += 3;
      cpuMicros += 2_000;
    });
    try {
      clock = 5;
      cpuMicros += 100_000;
      initial.resolve();
      await listed.promise;
      clock += 100;
      cpuMicros += 200_000;
      listing.resolve();
      await finalStarted.promise;
      clock += 20;
      cpuMicros += 300_000;
      final.resolve();
      await call.completion;
      expect(call.respond).toHaveBeenCalledWith(true, {
        catalogs: [expect.objectContaining({ id: privateText, hosts: [host] })],
      });
      await waitForDiagnosticEventsDrained();
      expect(trustedFlags).toEqual(Array.from({ length: phases.length }, () => true));
      expect(
        phases.map(({ name, durationMs, details }) => ({ name, durationMs, details })),
      ).toEqual([
        { name: "sessions.catalog.list.projection_initial", durationMs: 5, details: undefined },
        { name: "sessions.catalog.list.planning", durationMs: 2, details: { threadCpuMs: 1 } },
        { name: "sessions.catalog.list.provider", durationMs: 100, details: undefined },
        { name: "sessions.catalog.list.projection_final", durationMs: 20, details: undefined },
        { name: "sessions.catalog.list.delivery", durationMs: 3, details: { threadCpuMs: 2 } },
      ]);
      expect(phases.every((phase) => phase.trace?.traceId === leaderTrace.traceId)).toBe(true);
      expect(JSON.stringify(phases)).not.toContain(privateText);
    } finally {
      initial.resolve();
      listing.resolve();
      final.resolve();
      await Promise.allSettled([call.completion]);
    }
  });

  it("keeps coalesced followers attached to their own request without repeating planning", async () => {
    observe();
    const started = createDeferredCore();
    const gate = createDeferredCore();
    const list = vi.fn(async () => {
      started.resolve();
      await gate.promise;
      return [host];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider(privateText, { list }) }];
    const client = { connId: "shared-caller" };
    const leader = runWithDiagnosticTraceContext(leaderTrace, () =>
      startCall("sessions.catalog.list", {}, config, client),
    );
    const settledWork: Promise<unknown>[] = [Promise.allSettled([leader.completion])];
    try {
      await started.promise;
      const follower = runWithDiagnosticTraceContext(followerTrace, () =>
        startCall("sessions.catalog.list", {}, config, client),
      );
      settledWork.push(Promise.allSettled([follower.completion]));
      clock = 50;
      gate.resolve();
      await Promise.all([leader.completion, follower.completion]);
      await waitForDiagnosticEventsDrained();
      expect(list).toHaveBeenCalledOnce();
      expect(follower.respond.mock.calls).toEqual(leader.respond.mock.calls);
      const names = (traceId: string) =>
        phases.filter((event) => event.trace?.traceId === traceId).map((event) => event.name);
      expect(names(leaderTrace.traceId)).toEqual([
        "sessions.catalog.list.planning",
        "sessions.catalog.list.provider",
        "sessions.catalog.list.delivery",
      ]);
      expect(names(followerTrace.traceId)).toEqual([
        "sessions.catalog.list.coalesced",
        "sessions.catalog.list.delivery",
      ]);
      expect(phases.find((event) => event.name.endsWith(".coalesced"))).toMatchObject({
        durationMs: 50,
        details: undefined,
      });
    } finally {
      gate.resolve();
      await Promise.all(settledWork);
    }
  });

  it("preserves a failed readiness result and omits unvisited stages", async () => {
    observe();
    const failure = new Error(privateText);
    dirty = true;
    vi.spyOn(projection, "ensureMaterialized").mockImplementation(async () => {
      clock = 25;
      throw failure;
    });
    const call = startCall("sessions.catalog.list", {}, config);
    await expect(call.completion).rejects.toBe(failure);
    expect(call.respond).not.toHaveBeenCalled();
    await waitForDiagnosticEventsDrained();
    expect(phases).toEqual([
      expect.objectContaining({ name: "sessions.catalog.list.projection_initial", durationMs: 25 }),
    ]);
    expect(JSON.stringify(phases)).not.toContain(privateText);
  });

  it.each(["disabled", "no trusted consumer"])("avoids CPU sampling with %s", async (mode) => {
    if (mode === "disabled") {
      observe();
      setDiagnosticsEnabledForProcess(false);
    } else {
      onInternalDiagnosticEvent((event) => {
        if (event.type === "diagnostic.phase.completed") {
          phases.push(event);
        }
      });
    }
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider(privateText) }];
    const call = startCall("sessions.catalog.list", {}, config);
    await call.completion;
    await waitForDiagnosticEventsDrained();
    expect(call.respond).toHaveBeenCalledWith(true, expect.anything());
    expect(threadCpuUsage).not.toHaveBeenCalled();
    expect(phases).toEqual([]);
  });

  it("keeps elapsed observations and successful delivery when CPU sampling fails", async () => {
    observe();
    threadCpuUsage.mockImplementation(() => {
      throw new Error(privateText);
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider(privateText) }];
    const call = startCall("sessions.catalog.list", {}, config);
    await call.completion;
    await waitForDiagnosticEventsDrained();
    expect(call.respond).toHaveBeenCalledWith(true, expect.anything());
    expect(phases).toHaveLength(3);
    expect(phases.every((event) => event.details === undefined)).toBe(true);
    expect(JSON.stringify(phases)).not.toContain(privateText);
  });
});
