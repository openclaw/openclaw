import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DiagnosticEventInput,
  emitDiagnosticEvent as emit,
  emitInternalDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained as drain,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticStabilitySnapshot as readSnapshot,
  normalizeDiagnosticStabilityQuery,
  recordDiagnosticExporterHealth,
  resetDiagnosticStabilityRecorderForTest,
  selectDiagnosticStabilitySnapshot,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
  type DiagnosticExporterHealthUpdate,
  type DiagnosticStabilitySnapshot,
} from "./diagnostic-stability.js";

function makeEvent<Type extends DiagnosticEventInput["type"]>(
  type: Type,
  fields: Omit<Extract<DiagnosticEventInput, { type: Type }>, "type">,
) {
  return { type, ...fields };
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  expect(value).toEqual(expect.objectContaining(expected));
}

function expectAbsent(value: unknown, ...keys: string[]) {
  for (const key of keys) {
    expect(value).not.toHaveProperty(key);
  }
}

const model = { provider: "openai", model: "gpt-5.4" };
const scope = { runId: "private-run", sessionId: "private-session", sessionKey: "private-key" };
const delivery = { channel: "signal", source: "dispatch" };
const inbound = { ...scope, ...delivery };
const approval = {
  approvalId: "approval-123",
  reason: "session_rebound",
  phase: "direct_delivery",
} as const;
const context = {
  ...model,
  messageCount: 4,
  historyTextChars: 1200,
  historyImageBlocks: 1,
  maxMessageTextChars: 800,
  systemPromptChars: 300,
  promptChars: 100,
  promptImages: 1,
  contextTokenBudget: 200_000,
};
const phase = { phase: "model_call_started", provider: "anthropic", model: "claude" } as const;
const tool = {
  type: "tool.loop",
  toolName: "poll",
  level: "warning",
  action: "warn",
  detector: "known_poll_no_progress",
  count: 3,
} as const;
const talk = {
  type: "talk.event",
  talkEventType: "latency.metrics",
  mode: "realtime",
  transport: "gateway-relay",
  brain: "agent-consult",
  provider: "openai",
  final: true,
  durationMs: 12,
} as const;
const failure = {
  failureKind: "terminated" as const,
  memory: memory({ externalBytes: 20, arrayBuffersBytes: 10 }),
};

type Memory = NonNullable<DiagnosticStabilitySnapshot["events"][number]["memory"]>;
function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    rssBytes: 100,
    heapTotalBytes: 80,
    heapUsedBytes: 40,
    externalBytes: 10,
    arrayBuffersBytes: 5,
    ...overrides,
  };
}

function recordExporter(
  update: Pick<DiagnosticExporterHealthUpdate, "status"> & Partial<DiagnosticExporterHealthUpdate>,
  exporter = "diagnostics-otel",
) {
  recordDiagnosticExporterHealth(exporter, {
    signal: "traces",
    transport: "otlp-http-protobuf",
    ...update,
  });
}
const exporterEvents = () => readSnapshot({ type: "telemetry.exporter", limit: 1000 }).events;
const expectRoutes = (target: string, expected: Record<string, unknown>[]) =>
  expect(exporterEvents().filter((event) => event.target === target)).toMatchObject(expected);
const startExporter = (update: Partial<DiagnosticExporterHealthUpdate> = {}) =>
  recordExporter({ status: "started", reason: "configured", ...update });

function expectQueryError(
  params: Parameters<typeof normalizeDiagnosticStabilityQuery>[0],
  message: string,
) {
  expect(() => normalizeDiagnosticStabilityQuery(params)).toThrow(message);
}

function recordPayloads() {
  emit({ type: "webhook.received", channel: "telegram" });
  emit({ type: "payload.large", surface: "chat.history", action: "rejected" });
  emit({ type: "payload.large", surface: "chat.history", action: "chunked" });
  return readSnapshot();
}

describe("diagnostic stability recorder", () => {
  beforeEach(() => {
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
    startDiagnosticStabilityRecorder();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stopDiagnosticStabilityRecorder();
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
  });

  it.each<[DiagnosticEventInput, Record<string, unknown>, string[]?]>([
    [
      {
        type: "run.completed",
        ...scope,
        durationMs: 12,
        outcome: "aborted",
        abortCause: "private-cause",
        timeoutPhase: "private-phase",
        timeoutSource: "private-source",
      } as unknown as DiagnosticEventInput,
      { outcome: "aborted" },
      ["abortCause", "timeoutPhase", "timeoutSource"],
    ],
    [
      makeEvent("message.processed", {
        channel: "telegram",
        outcome: "error",
        reason: "raw error with user content",
      }),
      { outcome: "error" },
      ["reason"],
    ],
    [makeEvent("exec.approval.followup_suppressed", { ...approval }), approval],
    [
      makeEvent("message.received", {
        ...inbound,
        messageId: "private-message",
        chatId: "private-chat",
      }),
      delivery,
      ["messageId", "chatId"],
    ],
    [
      makeEvent("message.dispatch.completed", { ...inbound, durationMs: 12, outcome: "completed" }),
      { ...delivery, outcome: "completed" },
    ],
    [
      makeEvent("session.turn.created", {
        ...scope,
        agentId: "main",
        channel: "signal",
        trigger: "user",
      }),
      { source: "main", channel: "signal", outcome: "user" },
    ],
    [
      makeEvent("context.assembled", { ...scope, ...context }),
      { ...model, count: 4, context: { limit: 200_000 } },
      ["promptChars", "systemPromptChars"],
    ],
    [
      makeEvent("run.execution_phase", { ...scope, ...phase, tool: "read" }),
      { ...phase, toolName: "read" },
      ["reason"],
    ],
    [
      makeEvent("tool.execution.error", {
        toolName: "read",
        durationMs: 1,
        errorCategory: "bad reason\nwith content",
      }),
      { toolName: "read" },
      ["reason"],
    ],
    [
      makeEvent("model.call.error", {
        ...scope,
        callId: "private-call",
        ...model,
        durationMs: 1,
        requestPayloadBytes: 1234,
        responseStreamBytes: 567,
        errorCategory: "TypeError",
        ...failure,
      }),
      {
        ...model,
        durationMs: 1,
        requestBytes: 1234,
        responseBytes: 567,
        reason: "TypeError",
        ...failure,
      },
    ],
    [
      makeEvent("message.delivery.error", {
        ...scope,
        channel: "matrix",
        deliveryKind: "text",
        durationMs: 12,
        errorCategory: "TypeError",
      }),
      {
        channel: "matrix",
        deliveryKind: "text",
        durationMs: 12,
        outcome: "error",
        reason: "TypeError",
      },
    ],
    [{ ...tool, ...scope, message: "private-message" }, tool, ["message"]],
    [
      { ...talk, ...scope, turnId: "private-turn", captureId: "private-capture", byteLength: 345 },
      { ...talk, bytes: 345 },
      ["turnId", "captureId"],
    ],
  ])("projects event %# without payloads or identifiers", async (input, fields, absent = []) => {
    emit(input);
    await drain();
    const snapshot = readSnapshot();
    expectFields(snapshot.events[0], { type: input.type, ...fields });
    expectAbsent(snapshot.events[0], "runId", "callId", "sessionId", "sessionKey", ...absent);
    expect(JSON.stringify(snapshot.events)).not.toContain("private-");
  });

  it("summarizes memory samples and pressure", () => {
    emit({ type: "diagnostic.memory.sample", memory: memory() });
    emit({
      type: "diagnostic.memory.pressure",
      level: "warning",
      reason: "rss_threshold",
      thresholdBytes: 90,
      memory: memory({ rssBytes: 120, heapTotalBytes: 90, heapUsedBytes: 50 }),
    });

    expectFields(readSnapshot().summary.memory, {
      maxRssBytes: 120,
      maxHeapUsedBytes: 50,
      pressureCount: 1,
      latest: expect.objectContaining({ rssBytes: 120, heapUsedBytes: 50 }),
    });
  });

  it("keeps trusted exporter state sticky and rejects spoofed untrusted facts", async () => {
    emit({
      type: "telemetry.exporter",
      exporter: "diagnostics-otel",
      signal: "traces",
      status: "failure",
      reason: "emit_failed",
    });
    startExporter({ endpointMode: "default_endpoint" });
    recordExporter({
      endpointMode: "default_endpoint",
      status: "failure",
      reason: "export_failed",
      errorCategory: "https://collector.example/private",
    });
    for (let index = 0; index < 1005; index += 1) {
      emit({ type: "message.queued", source: "test", queueDepth: index });
    }
    await drain();

    const snapshot = readSnapshot({ type: "telemetry.exporter", limit: 1000 });
    const defaultSnapshot = readSnapshot({ limit: 1000 });

    expectFields(snapshot, {
      capacity: 16,
      count: 1,
      events: [
        expect.objectContaining({
          type: "telemetry.exporter",
          source: "diagnostics-otel",
          target: "traces",
          transport: "otlp-http-protobuf",
          outcome: "failure",
          reason: "export_failed",
          mode: "default_endpoint",
        }),
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain("collector.example");
    expect(defaultSnapshot.events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "telemetry.exporter" })]),
    );
  });

  it.each([
    ["traces", "default_endpoint"],
    ["metrics", "configured"],
  ] as const)(
    "retains %s ownership through startup failure and recovery",
    (signal, endpointMode) => {
      recordExporter({ signal, endpointMode, status: "failure", reason: "start_failed" });
      expectRoutes(signal, [{ outcome: "failure", reason: "start_failed", mode: endpointMode }]);
      recordExporter({ signal, status: "recovered", reason: "export_failed" });
      expectRoutes(signal, [{ outcome: "recovered", reason: "export_failed", mode: endpointMode }]);
    },
  );

  it("keeps safe generic codes while dropping unsafe sources and redacting transports", () => {
    recordExporter(
      {
        signal: "metrics",
        transport: "prometheus-scrape",
        status: "started",
        reason: "configured",
      },
      "diagnostics-prometheus",
    );
    recordExporter(
      {
        signal: "logs",
        transport: "collector.internal:4318",
        endpointMode:
          "https://private.example/mode" as DiagnosticExporterHealthUpdate["endpointMode"],
        status: "failure",
        reason: "queue_full",
        errorCategory: "TypeError",
      },
      "custom-exporter",
    );
    recordExporter(
      { transport: "vendor-proto", status: "failure", reason: "export_failed" },
      "https://private.example/exporter",
    );
    recordExporter({
      signal: "private-signal",
      status: "failure",
      reason: "export_failed",
    } as unknown as DiagnosticExporterHealthUpdate);
    recordExporter({
      status: "private-status",
      reason: "export_failed",
    } as unknown as DiagnosticExporterHealthUpdate);

    const snapshot = readSnapshot({ type: "telemetry.exporter", limit: 1000 });
    expect(snapshot.events).toMatchObject([
      {
        source: "diagnostics-prometheus",
        transport: "prometheus-scrape",
      },
      {
        source: "custom-exporter",
        outcome: "failure",
        reason: "queue_full",
        errorCategory: "TypeError",
      },
    ]);
    expectAbsent(snapshot.events[1], "transport", "mode");
    expect(JSON.stringify(snapshot)).not.toContain("collector.internal");
    expect(JSON.stringify(snapshot)).not.toContain("private.example");
    expect(JSON.stringify(snapshot)).not.toContain("private-signal");
    expect(JSON.stringify(snapshot)).not.toContain("private-status");
  });

  it("replaces retired routes while retaining every current logs both route", () => {
    startExporter();
    recordExporter({ status: "dropped" });
    startExporter({ transport: "external-sdk" });

    expect(exporterEvents()).toMatchObject([
      {
        target: "traces",
        transport: "external-sdk",
        outcome: "started",
      },
    ]);

    recordExporter({ transport: "external-sdk", status: "dropped" });
    recordExporter({ status: "failure", reason: "unsupported_protocol" });
    startExporter({ signal: "logs" });
    startExporter({ signal: "logs", transport: "stdout" });

    expectRoutes("traces", [
      {
        transport: "otlp-http-protobuf",
        outcome: "failure",
        reason: "unsupported_protocol",
      },
    ]);
    expectRoutes("logs", [
      { transport: "otlp-http-protobuf", outcome: "started" },
      { transport: "stdout", outcome: "started" },
    ]);

    recordExporter({ status: "dropped" });
    startExporter();

    expectRoutes("traces", [{ transport: "otlp-http-protobuf", outcome: "started" }]);

    recordExporter({ signal: "logs", status: "dropped" });
    recordExporter({ signal: "logs", transport: "stdout", status: "dropped" });
    startExporter({ signal: "logs", transport: "stdout" });

    expectRoutes("logs", [{ transport: "stdout", outcome: "started" }]);
  });

  it("admits sanitized trusted model requests but rejects other trusted events before cloning", async () => {
    const clone = vi.spyOn(globalThis, "structuredClone");
    emitTrustedDiagnosticEvent({ type: "model.usage", usage: { total: 42 } });
    expect(clone).not.toHaveBeenCalled();
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      ...scope,
      ...model,
      callId: "private-call",
      observationUnit: "request",
    });
    await drain();
    emit({ type: "model.usage", usage: { total: 7 } });
    expect(readSnapshot().events).toMatchObject([
      { type: "model.call.started", ...model },
      { type: "model.usage", seq: 3, usage: { total: 7 } },
    ]);
    expect(JSON.stringify(readSnapshot())).not.toContain("private-");
  });

  it("keeps async queue drop summaries after drained queued events for sinceSeq polling", async () => {
    for (let index = 0; index < 10_001; index += 1) {
      emit({
        type: "model.call.started",
        runId: `overflow-run-${index}`,
        callId: `overflow-call-${index}`,
        ...model,
      });
    }

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const midDrainSnapshot = readSnapshot({ limit: 1000 });
    expect(midDrainSnapshot.lastSeq).toBe(100);
    expect(
      midDrainSnapshot.events.some((event) => event.type === "diagnostic.async_queue.dropped"),
    ).toBe(false);

    await drain();

    const sinceMidDrain = readSnapshot({
      sinceSeq: midDrainSnapshot.lastSeq,
      limit: 1000,
    });
    const dropSummary = sinceMidDrain.events.find(
      (event) => event.type === "diagnostic.async_queue.dropped",
    );
    expectFields(dropSummary, {
      type: "diagnostic.async_queue.dropped",
      droppedEvents: 1,
      droppedUntrustedEvents: 1,
      queueLength: 0,
    });
    expect(
      sinceMidDrain.events.filter((event) => event.type === "model.call.started"),
    ).not.toHaveLength(0);
    expect(sinceMidDrain.lastSeq).toBeGreaterThan(10_000);
  });

  it("applies query filters to persisted snapshots without mutating the source", () => {
    const snapshot = recordPayloads();
    const selected = selectDiagnosticStabilitySnapshot(snapshot, {
      type: "payload.large",
      limit: 1,
    });

    expectFields(selected, { count: 2, firstSeq: 2, lastSeq: 3 });
    expect(selected.events).toHaveLength(1);
    expectFields(selected.events[0], { seq: 3, type: "payload.large", action: "chunked" });
    expectFields(selected.summary.byType, { "payload.large": 2 });
    expectFields(selected.summary.payloadLarge, {
      count: 2,
      rejected: 1,
      chunked: 1,
      bySurface: { "chat.history": 2 },
    });
    expect(snapshot.events).toHaveLength(3);
    expect(selectDiagnosticStabilitySnapshot(snapshot, { sinceSeq: 2 }).events).toMatchObject([
      { seq: 3, type: "payload.large", action: "chunked" },
    ]);
  });

  it.each([
    [
      { limit: "25", type: " payload.large ", sinceSeq: "2" },
      { limit: 25, type: "payload.large", sinceSeq: 2 },
    ],
    [{}, { limit: 10, type: undefined, sinceSeq: undefined }],
    [
      { sinceSeq: "0", limit: 7 },
      { limit: 7, type: undefined, sinceSeq: 0 },
    ],
  ])("normalizes query %j", (input, expected) => {
    expect(normalizeDiagnosticStabilityQuery(input, { defaultLimit: 10 })).toEqual(expected);
  });

  it.each(["limit", "sinceSeq"] as const)("rejects invalid %s integers", (field) => {
    for (const value of [
      "0x2",
      -1,
      Number.MAX_SAFE_INTEGER + 1,
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      expectQueryError({ [field]: value }, field + " must be a non-negative integer");
    }
  });
  it.each(["", "   "])("rejects empty type %j", (type) => {
    expectQueryError({ type }, "type must be a non-empty string");
  });
  it("distinguishes safe sequence numbers from the bounded limit", () => {
    const safe = Number.MAX_SAFE_INTEGER;
    for (const sinceSeq of [safe, String(safe)]) {
      expect(normalizeDiagnosticStabilityQuery({ sinceSeq }).sinceSeq).toBe(safe);
    }
    for (const limit of [0, safe]) {
      expectQueryError({ limit }, "limit must be between 1 and 1000");
    }
  });

  it("excludes internal-only event families from the snapshot", async () => {
    emitInternalDiagnosticEvent({
      type: "diagnostic.child_process.spawn",
      family: "node",
      count: 2,
      intervalMs: 60_000,
    });
    emitInternalDiagnosticEvent({ type: "gateway.http.cancelled", source: "client" });
    emit({
      type: "worker.request",
      kind: "sessionTranscript",
      requestClass: "task",
      phase: "queued",
      queueDepth: 1,
    });
    emit({ type: "secret.egress", outcome: "forwarded", substituted: false });
    emit({
      type: "tool.catalog",
      source: "builtin",
      mode: "code-mode",
      toolCount: 12,
    });
    await drain();
    expect(readSnapshot().events).toEqual([]);
  });
});
