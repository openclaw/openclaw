import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
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
import * as sessionPresentation from "../session-row-presentation.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import * as sessionModels from "../session-utils-model.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
  seedSessions,
  sessionReadHandlers,
} from "./sessions-read-cache.test-support.js";
import { sessionLog } from "./sessions-shared.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";
import type { RespondFn } from "./types.js";

const reusedRowMetrics = {
  pid: process.pid,
  threadId,
  isMainThread,
  rowSyncMs: 20,
  prepareSyncMs: 0,
  rowThreadCpuMs: 1.375,
  responseThreadCpuMs: 0,
  yieldCount: 1,
  selectedRowCount: 1,
  materializedRowCount: 0,
  reusedRowCount: 1,
};

function captureDiagnostics(events: unknown[]) {
  const diagnostics = channel("openclaw.session.list");
  const collect = (event: unknown) => events.push(event);
  diagnostics.subscribe(collect);
  return { [Symbol.dispose]: () => diagnostics.unsubscribe(collect) };
}

let previousDiagnostics: boolean;
let clock: number;
let cpu: NodeJS.CpuUsage;
let cpuProbeFailure: Error | undefined;
const threadCpuProbe = vi.fn<(previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage>();
const threadCpuFields = ["prepareThreadCpuMs", "rowThreadCpuMs", "responseThreadCpuMs"];
let records: Array<{ trace: DiagnosticTraceContext | undefined; fields: Record<string, unknown> }>;
let preparationCpuByTrace: Map<string | undefined, number>;
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
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
  preparationCpuByTrace = new Map();
  vi.spyOn(sessionLog, "isEnabled").mockReturnValue(true);
  vi.spyOn(sessionLog, "warn").mockImplementation((message, fields) => {
    if (message === "slow session list") {
      records.push({ trace: getActiveDiagnosticTraceContext(), fields: fields ?? {} });
    }
  });
});
afterEach(() => {
  setDiagnosticsEnabledForProcess(previousDiagnostics);
  vi.restoreAllMocks();
});

async function prepareListFixture() {
  const context = requestContext(await seedSessions());
  const client = identifiedClient("owner@example.com");
  await initializeSessionReadContext(context);
  const projection = getSessionRowProjection(context)!;
  await projection.ensureMaterialized();
  const request = { agentId: "main", limit: 1 };
  return { context, client, projection, list: () => listSessions({ context, client, request }) };
}

function delaySelection(
  projection: Awaited<ReturnType<typeof prepareListFixture>>["projection"],
  once = false,
) {
  const ensure = projection.prepareSelection.bind(projection);
  const spy = vi.spyOn(projection, "prepareSelection");
  const delayed: typeof ensure = async (...args) => {
    await ensure(...args);
    clock += 1_100;
  };
  return once ? spy.mockImplementationOnce(delayed) : spy.mockImplementation(delayed);
}

function expectNoCpuFields(record: unknown) {
  for (const field of threadCpuFields) {
    expect(record).not.toHaveProperty(field);
  }
}

function expectedPreparationCpu(trace?: DiagnosticTraceContext) {
  const charged = preparationCpuByTrace.get(trace?.traceId);
  expect(charged).toBeGreaterThan(0);
  return charged;
}

function controlProjectionClock(afterRow?: () => void) {
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const presented = vi.fn();
  const prepare = sessionPresentation.prepareSessionRowPublication;
  vi.spyOn(sessionPresentation, "prepareSessionRowPublication").mockImplementation((...args) => {
    try {
      const recipient = prepare(...args);
      return (...viewer) => {
        const presentation = recipient(...viewer);
        return {
          ...presentation,
          snapshot(...rowArgs: Parameters<typeof presentation.snapshot>) {
            try {
              return presentation.snapshot(...rowArgs);
            } finally {
              presented();
              clock += 20;
              cpu.user += 750;
              cpu.system += 250;
              afterRow?.();
            }
          },
        };
      };
    } finally {
      cpu.user += 1_250;
      cpu.system += 250;
      // Readiness can repeat selection; each trace must account for all of its injected work.
      const trace = getActiveDiagnosticTraceContext()?.traceId;
      preparationCpuByTrace.set(trace, (preparationCpuByTrace.get(trace) ?? 0) + 1.5);
    }
  });
  const defaults = sessionModels.getSessionDefaults;
  vi.spyOn(sessionModels, "getSessionDefaults").mockImplementation((...args) => {
    try {
      return defaults(...args);
    } finally {
      cpu.user += 250;
      cpu.system += 125;
    }
  });
  return presented;
}

test("attributes slow-warning operations", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { context, client, projection } = await prepareListFixture();
    context.subscribeSessionEvents = vi.fn();
    client.connId = "private-connection";
    const request = {
      agentId: "main",
      limit: 1,
      source: "sidebar" as const,
      rowMode: "compact" as const,
      includeDerivedTitles: true,
    };
    delaySelection(projection);
    const presentation = controlProjectionClock();
    const trace = createDiagnosticTraceContext();
    const events: unknown[] = [];
    {
      using _ = captureDiagnostics(events);
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
      expect(responses).toMatchObject([
        [true, { subscribed: true, list: { sessions: listed.sessions } }, undefined, undefined],
      ]);
      expect(context.subscribeSessionEvents).toHaveBeenCalledWith(client.connId);
      expect(presentation).toHaveBeenCalledTimes(2);
      expect(events).toHaveLength(2);
      for (const [index, operation] of ["sessions.list", "sessions.subscribe"].entries()) {
        expect(events[index]).toMatchObject({
          ...reusedRowMetrics,
          operation,
          source: "sidebar",
          rowMode: "compact",
          limit: 1,
          offset: 0,
          filterKind: "agentId",
          handlerElapsedMs: 1_120,
          prepareThreadCpuMs: expectedPreparationCpu(index === 0 ? trace : undefined),
          responseThreadCpuMs: index === 0 ? 0 : 1.125,
          yieldWaitMs: 1_100,
          dirtyRowCount: 0,
          handlerOutcome: "returned",
          responseOutcome: "ok",
        });
        expect(events[index]).not.toHaveProperty("cacheRole");
      }
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
      expect(records.map((record) => record.fields)).toEqual(events);
    }
    threadCpuProbe.mockClear();
    await listSessions({ client, context, request });
    expect(events).toHaveLength(2);
    expect(threadCpuProbe).toHaveBeenCalled();
  }));

test("reports materialized and reused selected rows after a keyed commit", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { list, projection } = await prepareListFixture();
    const initial = await list();
    const query = { agentId: "main", key: initial.sessions[0]!.key };
    const entry = projection.describe(query)!.entry;
    controlProjectionClock();
    const events: unknown[] = [];
    using _ = captureDiagnostics(events);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: query.key },
      { ...entry, label: "Committed label" },
    );
    const result = await list();
    expect(result.sessions[0]?.label).toBe("Committed label");
    expect(events[0]).toMatchObject({
      selectedRowCount: 1,
      dirtyRowCount: 1,
      materializedRowCount: 1,
      reusedRowCount: 0,
    });
  }));

test("preserves and attributes a fast response error", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { context, client } = await prepareListFixture();
    setDiagnosticsEnabledForProcess(false);
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const failure = new Error("synthetic-private-synchronous-error");
    const fail = () => {
      clock += 25;
      cpu.user += 250;
      cpu.system += 125;
      throw failure;
    };
    const events: unknown[] = [];
    using _ = captureDiagnostics(events);
    await expect(
      sessionReadHandlers["sessions.list"]!({
        req: { type: "req", id: "private-request", method: "sessions.list" },
        params: { agentId: "main", limit: 1 },
        client,
        context,
        respond: fail,
        isWebchatConnect: () => true,
      }),
    ).rejects.toBe(failure);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      handlerElapsedMs: 25,
      handlerOutcome: "threw",
      responseOutcome: "threw",
      prepareSyncMs: 0,
      responseThreadCpuMs: 0.375,
    });
    expect(JSON.stringify(events)).not.toContain(failure.message);
    expect(sessionLog.warn).not.toHaveBeenCalled();
  }));

test("attributes concurrent presentation and readiness waits to each request trace", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { list, projection } = await prepareListFixture();
    const ensure = projection.prepareSelection.bind(projection);
    const release = createDeferredCore();
    const waiting = createDeferredCore();
    let waitingCount = 0;
    const readiness = vi
      .spyOn(projection, "prepareSelection")
      .mockImplementation(async (...args) => {
        if (++waitingCount === 2) {
          waiting.resolve();
        }
        await release.promise;
        await ensure(...args);
        queueMicrotask(() => {
          cpu.user += 500_000;
        });
      });
    const presentation = controlProjectionClock();
    const traces = [createDiagnosticTraceContext(), createDiagnosticTraceContext()];
    const pending = traces.map((trace) => runWithDiagnosticTraceContext(trace, list));
    for (const pendingRequest of pending) {
      void pendingRequest.catch(waiting.reject);
    }
    try {
      await waiting.promise;
      expect(readiness).toHaveBeenCalledTimes(2);
      clock += 1_500;
      cpu.user += 900_000;
      cpu.system += 100_000;
      release.resolve();
      const results = await Promise.all(pending);
      expect(results[0]?.sessions).toEqual(results[1]?.sessions);
      expect(presentation).toHaveBeenCalledTimes(2);
      expect(records).toHaveLength(2);
      for (const trace of traces) {
        const record = records.find((value) => value.trace?.traceId === trace.traceId);
        expect(record).toMatchObject({
          trace,
          fields: {
            ...reusedRowMetrics,
            prepareThreadCpuMs: expectedPreparationCpu(trace),
          },
        });
        expect(record?.fields.yieldWaitMs).toBeGreaterThanOrEqual(1_500);
        expect(record?.fields.phaseDurationsMs).toHaveProperty(
          "materialize",
          record?.fields.yieldWaitMs,
        );
        expect(record?.fields.phaseDurationsMs).not.toHaveProperty("modelCatalog");
        expect(record?.fields).not.toHaveProperty("workTraceId");
      }
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
    }
  }));

test.each(["sink-throws", "cpu-start-throws", "cpu-finish-throws"])(
  "preserves the response when diagnostics are %s",
  (mode) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { list, projection } = await prepareListFixture();
      const cpuThrows = mode === "cpu-start-throws" || mode === "cpu-finish-throws";
      controlProjectionClock(() => {
        if (mode === "cpu-finish-throws") {
          cpuProbeFailure = new Error("synthetic CPU probe failure");
        }
      });
      threadCpuProbe.mockClear();
      if (mode === "cpu-start-throws") {
        cpuProbeFailure = new Error("synthetic CPU probe failure");
      }
      if (mode === "sink-throws") {
        vi.mocked(sessionLog.warn).mockImplementation(() => {
          throw new Error("synthetic sink failure");
        });
      }
      const readiness = delaySelection(projection, true);
      const result = await list();
      expect(readiness).toHaveBeenCalled();
      expect(result.sessions).toHaveLength(1);
      expect(sessionLog.warn).toHaveBeenCalledOnce();
      if (cpuThrows) {
        expect(threadCpuProbe.mock.results).toContainEqual({
          type: "throw",
          value: cpuProbeFailure,
        });
        expect(records).toHaveLength(1);
        expectNoCpuFields(records[0]?.fields);
        if (mode === "cpu-finish-throws") {
          expect(
            threadCpuProbe.mock.results.some(
              (reading) =>
                reading.type === "return" && reading.value.user + reading.value.system > 0,
            ),
          ).toBe(true);
        }
      }
    }),
);
