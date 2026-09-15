import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as titleReader from "../session-transcript-title-reader.js";
import * as rowProjection from "../session-utils-row.js";
import * as sessionUtils from "../session-utils.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
  seedSessions,
  sessionReadHandlers,
} from "./sessions-read-cache.test-support.js";
import { sessionLog } from "./sessions-shared.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";
import type { RespondFn } from "./types.js";

const scheduler = vi.hoisted(() => ({
  onYield: undefined as (() => Promise<void>) | undefined,
  afterYield: undefined as (() => void) | undefined,
}));
vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...actual,
    setImmediate: (...args: Parameters<typeof actual.setImmediate>) => {
      const pause = (async () => {
        const result = await actual.setImmediate(...args);
        await scheduler.onYield?.();
        return result;
      })();
      const afterYield = scheduler.afterYield;
      if (afterYield) {
        // Register unrelated work after the consumer's reaction, before its awaited continuation.
        queueMicrotask(() => {
          void pause.then(afterYield);
        });
      }
      return pause;
    },
  };
});

let previousDiagnostics: boolean;
let clock: number;
let cpu: NodeJS.CpuUsage;
let cpuProbeFailure: Error | undefined;
const threadCpuProbe = vi.fn<(previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage>();
const producerCpuFields = [
  "storeLoadThreadCpuMs",
  "prepareThreadCpuMs",
  "rowThreadCpuMs",
  "cachePublicationThreadCpuMs",
] as const;
const threadCpuFields = [...producerCpuFields, "cacheSelectionThreadCpuMs", "responseThreadCpuMs"];
let records: Array<{ trace: DiagnosticTraceContext | undefined; fields: Record<string, unknown> }>;
beforeEach(() => {
  previousDiagnostics = areDiagnosticsEnabledForProcess();
  setDiagnosticsEnabledForProcess(true);
  clock = 0;
  cpu = { user: 0, system: 0 };
  cpuProbeFailure = undefined;
  threadCpuProbe.mockReset().mockImplementation((previous = { user: 0, system: 0 }) => {
    if (cpuProbeFailure) {
      throw cpuProbeFailure;
    }
    return { user: cpu.user - previous.user, system: cpu.system - previous.system };
  });
  vi.spyOn(process, "threadCpuUsage").mockImplementation(threadCpuProbe);
  records = [];
  vi.spyOn(sessionLog, "isEnabled").mockReturnValue(true);
  vi.spyOn(sessionLog, "warn").mockImplementation((message, fields) => {
    if (message === "slow session list") {
      records.push({ trace: getActiveDiagnosticTraceContext(), fields: fields ?? {} });
    }
  });
});
afterEach(() => {
  scheduler.onYield = undefined;
  scheduler.afterYield = undefined;
  setDiagnosticsEnabledForProcess(previousDiagnostics);
  vi.restoreAllMocks();
});

function expectNoCpuFields(record: unknown, fields: readonly string[] = threadCpuFields) {
  for (const field of fields) {
    expect(record).not.toHaveProperty(field);
  }
}

function controlProjectionWork(afterPreparation?: () => void) {
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const load = sessionUtils.loadCombinedSessionStoreForGatewayCore;
  vi.spyOn(sessionUtils, "loadCombinedSessionStoreForGatewayCore").mockImplementation((...args) => {
    try {
      return load(...args);
    } finally {
      cpu.user += 650;
      cpu.system += 100;
    }
  });
  const buildRow = rowProjection.buildGatewaySessionRow;
  vi.spyOn(rowProjection, "buildGatewaySessionRow").mockImplementation((...args) => {
    try {
      return buildRow(...args);
    } finally {
      cpu.user += 2_250;
      cpu.system += 750;
    }
  });
  const read = titleReader.readSessionTitleFieldsFromTranscriptBatch;
  return vi
    .spyOn(titleReader, "readSessionTitleFieldsFromTranscriptBatch")
    .mockImplementation((...args) => {
      try {
        return read(...args);
      } finally {
        // Charge real synchronous work independently of the instrumentation's probe count.
        clock += 20;
        cpu.user += 1_250;
        cpu.system += 250;
        afterPreparation?.();
      }
    });
}

test.each(["channel-only", "slow-warning"])("attributes %s operations", async (mode) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = requestContext(await seedSessions());
    context.subscribeSessionEvents = vi.fn();
    const client = { ...identifiedClient("owner@example.com"), connId: "private-connection" };
    const request = { agentId: "main", limit: 1 };
    const warn = mode === "slow-warning";
    const catalogDelay = warn ? 1_100 : 0;
    setDiagnosticsEnabledForProcess(warn);
    vi.mocked(sessionLog.isEnabled).mockReturnValue(warn);
    context.readPreparedGatewayModelCatalog = async () => {
      clock += catalogDelay;
      return undefined;
    };
    const projection = controlProjectionWork();
    const trace = createDiagnosticTraceContext();
    const events: unknown[] = [];
    const diagnostics = channel("openclaw.session.list");
    const collect = (event: unknown) => events.push(event);
    diagnostics.subscribe(collect);
    try {
      const listed = await runWithDiagnosticTraceContext(trace, () =>
        listSessions({ client, context, request }),
      );
      const responses: Parameters<RespondFn>[] = [];
      await sessionSubscriptionHandlers["sessions.subscribe"]!({
        req: { type: "req", id: "private-request", method: "sessions.subscribe" },
        params: request,
        client,
        context,
        isWebchatConnect: () => true,
        respond: (...response) => {
          cpu.user += 750;
          cpu.system += 375;
          responses.push(response);
        },
      });
      expect(responses).toEqual([[true, { subscribed: true, list: listed }, undefined, undefined]]);
      expect(context.subscribeSessionEvents).toHaveBeenCalledWith(client.connId);
      expect(projection).toHaveBeenCalledOnce();
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        operation: "sessions.list",
        pid: process.pid,
        threadId,
        isMainThread,
        handlerElapsedMs: 20 + catalogDelay,
        cacheRole: "projection-owner",
        prepareSyncMs: 20,
        storeLoadThreadCpuMs: 0.75,
        prepareThreadCpuMs: 1.5,
        rowThreadCpuMs: 3,
        projectionPasses: 1,
        selectedRowCount: 1,
        handlerOutcome: "returned",
        responseOutcome: "ok",
      });
      expect(events[1]).toMatchObject({
        operation: "sessions.subscribe",
        handlerElapsedMs: catalogDelay,
        cacheRole: "completed-hit",
        responseThreadCpuMs: 1.125,
        selectedRowCount: 1,
        handlerOutcome: "returned",
        responseOutcome: "ok",
      });
      expect(events[1]).not.toHaveProperty("projectionPasses");
      expectNoCpuFields(events[1], producerCpuFields);
      const serialized = JSON.stringify(events);
      for (const privateValue of [
        client.connId,
        "private-request",
        "owner@example.com",
        trace.traceId,
      ]) {
        expect(serialized).not.toContain(privateValue);
      }
      expect(serialized).not.toContain("agent:main:");
      if (warn) {
        expect(records.map((record) => record.fields)).toEqual(events);
      } else {
        expect(sessionLog.warn).not.toHaveBeenCalled();
      }
    } finally {
      diagnostics.unsubscribe(collect);
    }
    threadCpuProbe.mockClear();
    await listSessions({ client, context, request });
    expect(events).toHaveLength(2);
    if (warn) {
      expect(threadCpuProbe).toHaveBeenCalled();
    } else {
      expect(threadCpuProbe).not.toHaveBeenCalled();
    }
  });
});

test.each([
  { stage: "projection", cpuFailure: "none" },
  { stage: "response", cpuFailure: "none" },
  { stage: "projection", cpuFailure: "start" },
  { stage: "projection", cpuFailure: "finish" },
] as const)(
  "preserves a fast $stage error when CPU probe failure is $cpuFailure",
  async ({ stage, cpuFailure }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = requestContext(await seedSessions());
      setDiagnosticsEnabledForProcess(false);
      vi.spyOn(performance, "now").mockImplementation(() => clock);
      if (cpuFailure !== "none") {
        controlProjectionWork();
      }
      if (cpuFailure === "start") {
        cpuProbeFailure = new Error("synthetic CPU probe failure");
      }
      const failure = new Error("synthetic-private-projection-error");
      const fail = () => {
        clock += 25;
        cpu.user += 250;
        cpu.system += 125;
        if (cpuFailure === "finish") {
          cpuProbeFailure = new Error("synthetic CPU probe failure");
        }
        throw failure;
      };
      if (stage === "projection") {
        vi.spyOn(titleReader, "readSessionTitleFieldsFromTranscriptBatch").mockImplementation(fail);
      }
      const events: unknown[] = [];
      const diagnostics = channel("openclaw.session.list");
      const collect = (event: unknown) => events.push(event);
      diagnostics.subscribe(collect);
      try {
        await expect(
          stage === "projection"
            ? listSessions({
                client: identifiedClient("owner@example.com"),
                context,
                request: { agentId: "main", limit: 1 },
              })
            : sessionReadHandlers["sessions.list"]!({
                req: { type: "req", id: "private-request", method: "sessions.list" },
                params: { agentId: "main", limit: 1 },
                client: identifiedClient("owner@example.com"),
                context,
                respond: fail,
                isWebchatConnect: () => true,
              }),
        ).rejects.toBe(failure);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          operation: "sessions.list",
          handlerElapsedMs: 25,
          cacheRole: "projection-owner",
          handlerOutcome: "threw",
          responseOutcome: stage === "projection" ? "none" : "threw",
        });
        if (cpuFailure === "none") {
          expect(events[0]).toMatchObject({
            [stage === "projection" ? "prepareThreadCpuMs" : "responseThreadCpuMs"]: 0.375,
          });
        } else {
          expect(threadCpuProbe.mock.results).toContainEqual({
            type: "throw",
            value: cpuProbeFailure,
          });
          if (cpuFailure === "finish") {
            expect(
              threadCpuProbe.mock.results.some(
                (reading) =>
                  reading.type === "return" && reading.value.user + reading.value.system > 0,
              ),
            ).toBe(true);
          }
          expectNoCpuFields(events[0]);
        }
        if (stage === "projection") {
          expectNoCpuFields(events[0], [
            "rowThreadCpuMs",
            "cachePublicationThreadCpuMs",
            "responseThreadCpuMs",
          ]);
        }
        expect(JSON.stringify(events)).not.toContain(failure.message);
        expect(sessionLog.warn).not.toHaveBeenCalled();
      } finally {
        diagnostics.unsubscribe(collect);
      }
    });
  },
);

test("separates producer work, follower wait, and completed hits under their own request traces", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = await seedSessions();
    const context = requestContext(config);
    const client = identifiedClient("owner@example.com");
    const request = { agentId: "main", limit: 1 };
    const catalog = vi.fn(async () => undefined);
    context.readPreparedGatewayModelCatalog = catalog;
    const projection = controlProjectionWork();
    context.workerPlacementDiskSpaceReader = {
      read: () => undefined,
      version: () => {
        cpu.user += 1_250;
        return 0;
      },
    };
    const entered = createDeferredCore();
    const release = createDeferredCore();
    scheduler.onYield = async () => {
      entered.resolve();
      await release.promise;
    };
    const unrelatedWork = createDeferredCore();
    scheduler.afterYield = () => {
      cpu.user += 900_000;
      cpu.system += 100_000;
      unrelatedWork.resolve();
    };
    const ownerTrace = createDiagnosticTraceContext();
    const followerTrace = createDiagnosticTraceContext();
    const owner = runWithDiagnosticTraceContext(ownerTrace, () =>
      listSessions({ client, context, request }),
    );
    await entered.promise;
    const follower = runWithDiagnosticTraceContext(followerTrace, () =>
      listSessions({ client, context, request }),
    );
    await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    clock += 1_500;
    release.resolve();
    const [owned, followed] = await Promise.all([owner, follower]);
    await unrelatedWork.promise;
    expect(followed).toBe(owned);
    expect(projection).toHaveBeenCalledOnce();
    expect(records).toHaveLength(2);
    const ownerRecord = records.find((record) => record.trace?.traceId === ownerTrace.traceId);
    const followerRecord = records.find(
      (record) => record.trace?.traceId === followerTrace.traceId,
    );
    expect(ownerRecord).toMatchObject({
      trace: ownerTrace,
      fields: {
        cacheRole: "projection-owner",
        pid: process.pid,
        threadId,
        isMainThread,
        prepareSyncMs: 20,
        storeLoadThreadCpuMs: 0.75,
        prepareThreadCpuMs: 1.5,
        rowThreadCpuMs: 3,
        cacheSelectionThreadCpuMs: 1.25,
        cachePublicationThreadCpuMs: 1.25,
        rowSyncMs: 0,
        yieldWaitMs: 1_500,
        yieldCount: 1,
        projectionPasses: 1,
        selectedRowCount: 1,
      },
    });
    expect(followerRecord).toMatchObject({
      trace: followerTrace,
      fields: {
        cacheRole: "in-flight-follower",
        cacheSelectionThreadCpuMs: 1.25,
        selectedRowCount: 1,
        workTraceId: ownerTrace.traceId,
        workSpanId: ownerTrace.spanId,
      },
    });
    expect(followerRecord?.fields).not.toHaveProperty("prepareSyncMs");
    expect(followerRecord?.fields).not.toHaveProperty("yieldWaitMs");
    expect(followerRecord?.fields).not.toHaveProperty("projectionPasses");
    expectNoCpuFields(followerRecord?.fields, producerCpuFields);

    scheduler.onYield = undefined;
    catalog.mockImplementation(async () => {
      clock += 1_100;
      return undefined;
    });
    const hitTrace = createDiagnosticTraceContext();
    const hit = await runWithDiagnosticTraceContext(hitTrace, () =>
      listSessions({ client, context, request }),
    );
    expect(hit).toBe(owned);
    expect(projection).toHaveBeenCalledOnce();
    expect(records).toHaveLength(3);
    expect(records[2]).toMatchObject({
      trace: hitTrace,
      fields: { cacheRole: "completed-hit", selectedRowCount: 1 },
    });
    expect(records[2]?.fields).not.toHaveProperty("projectionPasses");
    expect(records[2]?.fields).not.toHaveProperty("workTraceId");
    expect(records[2]?.fields).not.toHaveProperty("rowSyncMs");
    expectNoCpuFields(records[2]?.fields, producerCpuFields);
  });
});

test("accumulates the bounded visibility repairs without counting yielded waits as synchronous work", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = { agents: { list: [{ id: "main", default: true }] } };
    const newest = Date.now();
    const updatedAt = vi.spyOn(Date, "now");
    for (const [index, name] of ["first", "second", "third", "fourth"].entries()) {
      updatedAt.mockReturnValue(newest - index);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: `agent:main:repair-${name}` },
        {
          sessionId: `repair-${name}`,
          updatedAt: newest - index,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );
    }
    updatedAt.mockRestore();
    controlProjectionWork();
    let pass = 0;
    scheduler.onYield = async () => {
      const name = ["first", "second", "third"][pass++];
      if (name) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:repair-${name}` },
          { visibility: "draft" },
        );
      }
      clock += 500;
      cpu.user += 300_000;
    };
    const result = await listSessions({
      client: identifiedClient("viewer@example.com"),
      context: requestContext(config),
      request: { agentId: "main", limit: 1 },
    });
    expect(result.sessions.map((row) => row.key)).toEqual(["agent:main:repair-fourth"]);
    expect(records).toHaveLength(1);
    expect(records[0]?.fields).toMatchObject({
      cacheRole: "projection-owner",
      projectionPasses: 4,
      rowRepairCount: 2,
      fullReloadCount: 1,
      prepareSyncMs: 80,
      storeLoadThreadCpuMs: 1.5,
      prepareThreadCpuMs: 6,
      rowThreadCpuMs: 12,
      rowSyncMs: 0,
      yieldWaitMs: 2_000,
      yieldCount: 4,
      phaseDurationsMs: { rows: 2_080 },
    });
  });
});

test.each([
  "disabled",
  "sink-disabled",
  "sink-throws",
  "disabled-during-request",
  "cpu-start-throws",
  "cpu-finish-throws",
])("preserves the response when diagnostics are %s", async (mode) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = requestContext(await seedSessions());
    threadCpuProbe.mockClear();
    const cpuThrows = mode === "cpu-start-throws" || mode === "cpu-finish-throws";
    controlProjectionWork(() => {
      if (mode === "cpu-finish-throws") {
        cpuProbeFailure = new Error("synthetic CPU probe failure");
      }
    });
    if (mode === "cpu-start-throws") {
      cpuProbeFailure = new Error("synthetic CPU probe failure");
    }
    if (mode === "disabled") {
      setDiagnosticsEnabledForProcess(false);
    }
    if (mode === "sink-disabled") {
      vi.mocked(sessionLog.isEnabled).mockReturnValue(false);
    }
    if (mode === "sink-throws") {
      vi.mocked(sessionLog.warn).mockImplementation(() => {
        throw new Error("synthetic sink failure");
      });
    }
    context.readPreparedGatewayModelCatalog = async () => {
      clock += 1_100;
      if (mode === "disabled-during-request") {
        setDiagnosticsEnabledForProcess(false);
      }
      return undefined;
    };
    const result = await listSessions({
      client: identifiedClient("owner@example.com"),
      context,
      request: { agentId: "main", limit: 1 },
    });
    expect(result.sessions).toHaveLength(1);
    if (mode === "sink-throws" || cpuThrows) {
      expect(sessionLog.warn).toHaveBeenCalledOnce();
    } else {
      expect(sessionLog.warn).not.toHaveBeenCalled();
    }
    if (mode === "disabled" || mode === "sink-disabled") {
      expect(threadCpuProbe).not.toHaveBeenCalled();
    }
    if (cpuThrows) {
      expect(threadCpuProbe.mock.results).toContainEqual({
        type: "throw",
        value: cpuProbeFailure,
      });
      if (mode === "cpu-finish-throws") {
        expect(
          threadCpuProbe.mock.results.some(
            (reading) => reading.type === "return" && reading.value.user + reading.value.system > 0,
          ),
        ).toBe(true);
      }
      expect(records).toHaveLength(1);
      expectNoCpuFields(records[0]?.fields);
    }
  });
});

test("preserves the original projection error even when its slow diagnostic sink throws", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = requestContext(await seedSessions());
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const failure = new Error("synthetic projection failure");
    vi.spyOn(titleReader, "readSessionTitleFieldsFromTranscriptBatch").mockImplementation(() => {
      clock += 1_500;
      cpu.user += 500;
      cpu.system += 125;
      throw failure;
    });
    vi.mocked(sessionLog.warn).mockImplementation(() => {
      throw new Error("synthetic sink failure");
    });
    await expect(
      listSessions({
        client: identifiedClient("owner@example.com"),
        context,
        request: { agentId: "main" },
      }),
    ).rejects.toBe(failure);
    expect(sessionLog.warn).toHaveBeenCalledOnce();
    expect(sessionLog.warn).toHaveBeenCalledWith(
      "slow session list",
      expect.objectContaining({ prepareThreadCpuMs: 0.625, handlerOutcome: "threw" }),
    );
  });
});
