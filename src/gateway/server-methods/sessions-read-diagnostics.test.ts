import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
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
import * as sessionRows from "../session-utils-row.js";
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
  const prepare = sessionPresentation.prepareProjectedSessionPresentation;
  vi.spyOn(sessionPresentation, "prepareProjectedSessionPresentation").mockImplementation(
    (...args) => {
      try {
        return prepare(...args);
      } finally {
        cpu.user += 1_250;
        cpu.system += 250;
        // Readiness can repeat selection; each trace must account for all of its injected work.
        const trace = getActiveDiagnosticTraceContext()?.traceId;
        preparationCpuByTrace.set(trace, (preparationCpuByTrace.get(trace) ?? 0) + 1.5);
      }
    },
  );
  const defaults = sessionModels.getSessionDefaults;
  vi.spyOn(sessionModels, "getSessionDefaults").mockImplementation((...args) => {
    try {
      return defaults(...args);
    } finally {
      cpu.user += 250;
      cpu.system += 125;
    }
  });
  const present = sessionRows.presentSessionRow;
  return vi.spyOn(sessionRows, "presentSessionRow").mockImplementation((...args) => {
    try {
      return present(...args);
    } finally {
      clock += 20;
      cpu.user += 750;
      cpu.system += 250;
      afterRow?.();
    }
  });
}

test.each(["channel-only", "slow-warning"])("attributes %s operations", async (mode) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = requestContext(await seedSessions());
    context.subscribeSessionEvents = vi.fn();
    const client = { ...identifiedClient("owner@example.com"), connId: "private-connection" };
    const request = { agentId: "main", limit: 1, includeDerivedTitles: true };
    await initializeSessionReadContext(context);
    await getSessionRowProjection(context)!.ensureMaterialized();
    const owner = getSessionRowProjection(context)!;
    const ensure = owner.ensureMaterialized.bind(owner);
    const warn = mode === "slow-warning";
    const waitMs = warn ? 1_100 : 0;
    setDiagnosticsEnabledForProcess(warn);
    vi.mocked(sessionLog.isEnabled).mockReturnValue(warn);
    vi.spyOn(owner, "ensureMaterialized").mockImplementation(async () => {
      await ensure();
      clock += waitMs;
    });
    const presentation = controlProjectionClock();
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
      expect(responses).toMatchObject([
        [true, { subscribed: true, list: { sessions: listed.sessions } }, undefined, undefined],
      ]);
      expect(context.subscribeSessionEvents).toHaveBeenCalledWith(client.connId);
      expect(presentation).toHaveBeenCalledTimes(2);
      expect(events).toHaveLength(2);
      for (const [index, operation] of ["sessions.list", "sessions.subscribe"].entries()) {
        expect(events[index]).toMatchObject({
          operation,
          pid: process.pid,
          threadId,
          isMainThread,
          handlerElapsedMs: 20 + waitMs,
          prepareSyncMs: 0,
          rowSyncMs: 20,
          prepareThreadCpuMs: expectedPreparationCpu(index === 0 ? trace : undefined),
          rowThreadCpuMs: 1.375,
          responseThreadCpuMs: index === 0 ? 0 : 1.125,
          yieldWaitMs: waitMs,
          yieldCount: 1,
          selectedRowCount: 1,
          dirtyRowCount: 0,
          materializedRowCount: 0,
          reusedRowCount: 1,
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

test("reports materialized and reused selected rows after a keyed commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = requestContext(await seedSessions());
    const client = identifiedClient("owner@example.com");
    await initializeSessionReadContext(context);
    await getSessionRowProjection(context)!.ensureMaterialized();
    const projection = getSessionRowProjection(context)!;
    const initial = await listSessions({ client, context, request: { agentId: "main", limit: 1 } });
    const query = { agentId: "main", key: initial.sessions[0]!.key };
    const entry = projection.describe(query)!.entry;
    controlProjectionClock();
    const events: unknown[] = [];
    const diagnostics = channel("openclaw.session.list");
    const collect = (event: unknown) => events.push(event);
    diagnostics.subscribe(collect);
    try {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: query.key },
        { ...entry, label: "Committed label" },
      );
      const result = await listSessions({
        client,
        context,
        request: { agentId: "main", limit: 1 },
      });
      expect(result.sessions[0]?.label).toBe("Committed label");
      expect(events[0]).toMatchObject({
        selectedRowCount: 1,
        dirtyRowCount: 1,
        materializedRowCount: 1,
        reusedRowCount: 0,
      });
    } finally {
      diagnostics.unsubscribe(collect);
    }
  });
});

test("captures a fast failed readiness wait while preserving the original error", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = requestContext(await seedSessions());
    const client = identifiedClient("owner@example.com");
    await initializeSessionReadContext(context);
    await getSessionRowProjection(context)!.ensureMaterialized();
    setDiagnosticsEnabledForProcess(false);
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const failure = new Error("synthetic-private-projection-error");
    vi.spyOn(getSessionRowProjection(context)!, "ensureMaterialized").mockImplementationOnce(
      async () => {
        clock += 25;
        cpu.user += 500_000;
        throw failure;
      },
    );
    const events: unknown[] = [];
    const diagnostics = channel("openclaw.session.list");
    const collect = (event: unknown) => events.push(event);
    diagnostics.subscribe(collect);
    try {
      await expect(
        listSessions({ client, context, request: { agentId: "main", limit: 1 } }),
      ).rejects.toBe(failure);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        operation: "sessions.list",
        handlerElapsedMs: 25,
        handlerOutcome: "threw",
        responseOutcome: "none",
      });
      expect(JSON.stringify(events)).not.toContain(failure.message);
      expectNoCpuFields(events[0]);
      expect(threadCpuProbe).not.toHaveBeenCalled();
      expect(sessionLog.warn).not.toHaveBeenCalled();
    } finally {
      diagnostics.unsubscribe(collect);
    }
  });
});

test.each([
  { stage: "selection", cpuFailure: "none" },
  { stage: "row", cpuFailure: "none" },
  { stage: "response", cpuFailure: "none" },
  { stage: "selection", cpuFailure: "start" },
  { stage: "selection", cpuFailure: "finish" },
] as const)(
  "preserves a fast $stage error when CPU probe failure is $cpuFailure",
  async ({ stage, cpuFailure }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = requestContext(await seedSessions());
      await initializeSessionReadContext(context);
      await getSessionRowProjection(context)!.ensureMaterialized();
      setDiagnosticsEnabledForProcess(false);
      vi.spyOn(performance, "now").mockImplementation(() => clock);
      const failure = new Error("synthetic-private-synchronous-error");
      const fail = () => {
        clock += 25;
        cpu.user += 250;
        cpu.system += 125;
        if (cpuFailure === "finish") {
          cpuProbeFailure = new Error("synthetic CPU probe failure");
        }
        throw failure;
      };
      if (stage === "selection") {
        vi.spyOn(getSessionRowProjection(context)!, "selectEntries").mockImplementation(fail);
      } else if (stage === "row") {
        vi.spyOn(sessionRows, "presentSessionRow").mockImplementation(fail);
      }
      if (cpuFailure === "start") {
        cpuProbeFailure = new Error("synthetic CPU probe failure");
      }
      const events: unknown[] = [];
      const diagnostics = channel("openclaw.session.list");
      const collect = (event: unknown) => events.push(event);
      diagnostics.subscribe(collect);
      try {
        await expect(
          sessionReadHandlers["sessions.list"]!({
            req: { type: "req", id: "private-request", method: "sessions.list" },
            params: { agentId: "main", limit: 1 },
            client: identifiedClient("owner@example.com"),
            context,
            respond: stage === "response" ? fail : vi.fn(),
            isWebchatConnect: () => true,
          }),
        ).rejects.toBe(failure);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          handlerElapsedMs: 25,
          handlerOutcome: "threw",
          responseOutcome: stage === "response" ? "threw" : "none",
          prepareSyncMs: stage === "selection" ? 25 : 0,
        });
        if (cpuFailure === "none") {
          const metric = stage === "selection" ? "prepare" : stage;
          expect(events[0]).toHaveProperty(`${metric}ThreadCpuMs`, 0.375);
        } else {
          expect(threadCpuProbe.mock.results).toContainEqual({
            type: "throw",
            value: cpuProbeFailure,
          });
          expectNoCpuFields(events[0]);
        }
        expect(JSON.stringify(events)).not.toContain(failure.message);
        expect(sessionLog.warn).not.toHaveBeenCalled();
      } finally {
        diagnostics.unsubscribe(collect);
      }
    });
  },
);

test("attributes concurrent presentation and readiness waits to each request trace", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = requestContext(await seedSessions());
    const client = identifiedClient("owner@example.com");
    const request = { agentId: "main", limit: 1 };
    await initializeSessionReadContext(context);
    await getSessionRowProjection(context)!.ensureMaterialized();
    const projection = getSessionRowProjection(context)!;
    const ensure = projection.ensureMaterialized.bind(projection);
    const release = createDeferredCore();
    const waiting = createDeferredCore();
    let waitingCount = 0;
    const readiness = vi.spyOn(projection, "ensureMaterialized").mockImplementation(async () => {
      if (++waitingCount === 2) {
        waiting.resolve();
      }
      await release.promise;
      await ensure();
      queueMicrotask(() => {
        cpu.user += 500_000;
      });
    });
    const presentation = controlProjectionClock();
    const traces = [createDiagnosticTraceContext(), createDiagnosticTraceContext()];
    const pending = traces.map((trace) =>
      runWithDiagnosticTraceContext(trace, () => listSessions({ client, context, request })),
    );
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
            pid: process.pid,
            threadId,
            isMainThread,
            rowSyncMs: 20,
            prepareSyncMs: 0,
            prepareThreadCpuMs: expectedPreparationCpu(trace),
            rowThreadCpuMs: 1.375,
            responseThreadCpuMs: 0,
            yieldCount: 1,
            selectedRowCount: 1,
            materializedRowCount: 0,
            reusedRowCount: 1,
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
  });
});

test("reports fresh visibility after a readiness yield without charging the wait as row CPU", async () => {
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
    const client = identifiedClient("viewer@example.com");
    const context = requestContext(config);
    await initializeSessionReadContext(context);
    await getSessionRowProjection(context)!.ensureMaterialized();
    const projection = getSessionRowProjection(context)!;
    controlProjectionClock();
    const ensure = projection.ensureMaterialized.bind(projection);
    vi.spyOn(projection, "ensureMaterialized").mockImplementationOnce(async () => {
      for (const name of ["first", "second", "third"]) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:repair-${name}` },
          { visibility: "draft" },
        );
      }
      await ensure();
      clock += 2_000;
      cpu.user += 300_000;
    });
    const result = await listSessions({ client, context, request: { agentId: "main", limit: 1 } });
    expect(result.sessions.map((row) => row.key)).toEqual(["agent:main:repair-fourth"]);
    expect(records).toHaveLength(1);
    expect(records[0]?.fields).toMatchObject({
      selectedRowCount: 1,
      materializedRowCount: 0,
      reusedRowCount: 1,
      prepareSyncMs: 0,
      rowSyncMs: 20,
      prepareThreadCpuMs: expectedPreparationCpu(),
      rowThreadCpuMs: 1.375,
      yieldWaitMs: 2_000,
      yieldCount: 1,
      phaseDurationsMs: { rows: 20 },
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
    const client = identifiedClient("owner@example.com");
    await initializeSessionReadContext(context);
    await getSessionRowProjection(context)!.ensureMaterialized();
    const projection = getSessionRowProjection(context)!;
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
    const ensure = projection.ensureMaterialized.bind(projection);
    vi.spyOn(projection, "ensureMaterialized").mockImplementationOnce(async () => {
      await ensure();
      clock += 1_100;
      if (mode === "disabled-during-request") {
        setDiagnosticsEnabledForProcess(false);
      }
    });
    const result = await listSessions({
      client,
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
      expect(records).toHaveLength(1);
      expectNoCpuFields(records[0]?.fields);
      if (mode === "cpu-finish-throws") {
        expect(
          threadCpuProbe.mock.results.some(
            (reading) => reading.type === "return" && reading.value.user + reading.value.system > 0,
          ),
        ).toBe(true);
      }
    }
  });
});

test("preserves the original selection error even when its slow diagnostic sink throws", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = requestContext(await seedSessions());
    const client = identifiedClient("owner@example.com");
    await initializeSessionReadContext(context);
    await getSessionRowProjection(context)!.ensureMaterialized();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const failure = new Error("synthetic projection failure");
    vi.spyOn(getSessionRowProjection(context)!, "selectEntries").mockImplementationOnce(() => {
      clock += 1_500;
      cpu.user += 500;
      cpu.system += 125;
      throw failure;
    });
    vi.mocked(sessionLog.warn).mockImplementation(() => {
      throw new Error("synthetic sink failure");
    });
    await expect(
      listSessions({ client, context, request: { agentId: "main", limit: 1 } }),
    ).rejects.toBe(failure);
    expect(sessionLog.warn).toHaveBeenCalledOnce();
    expect(sessionLog.warn).toHaveBeenCalledWith(
      "slow session list",
      expect.objectContaining({ prepareThreadCpuMs: 0.625, handlerOutcome: "threw" }),
    );
  });
});
