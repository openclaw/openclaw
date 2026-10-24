import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  emitInternalDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticStabilitySnapshot,
  normalizeDiagnosticStabilityQuery,
  recordDiagnosticExporterHealth,
  resetDiagnosticStabilityRecorderForTest,
  selectDiagnosticStabilitySnapshot,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
  type DiagnosticExporterHealthUpdate,
  type DiagnosticStabilitySnapshot,
} from "./diagnostic-stability.js";

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  expect(value).toEqual(expect.objectContaining(expected));
}

function expectAbsent(value: unknown, ...keys: string[]) {
  for (const key of keys) {
    expect(value).not.toHaveProperty(key);
  }
}

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
const exporterEvents = () =>
  getDiagnosticStabilitySnapshot({ type: "telemetry.exporter", limit: 1000 }).events;
const startExporter = (update: Partial<DiagnosticExporterHealthUpdate> = {}) =>
  recordExporter({ status: "started", reason: "configured", ...update });

function expectQueryError(
  params: Parameters<typeof normalizeDiagnosticStabilityQuery>[0],
  message: string,
) {
  expect(() => normalizeDiagnosticStabilityQuery(params)).toThrow(message);
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

  it("keeps stable reason codes but drops free-form reason text", () => {
    emitDiagnosticEvent({
      type: "payload.large",
      surface: "gateway.http.json",
      action: "rejected",
      reason: "json_body_limit",
    });
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      outcome: "error",
      reason: "raw error with user content",
    });

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expectFields(snapshot.events[0], { type: "payload.large", reason: "json_body_limit" });
    expectFields(snapshot.events[1], { type: "message.processed", outcome: "error" });
    expect(snapshot.events[1]).not.toHaveProperty("reason");
  });

  it("records exec approval followup suppression metadata", async () => {
    emitDiagnosticEvent({
      type: "exec.approval.followup_suppressed",
      approvalId: "approval-123",
      reason: "session_rebound",
      phase: "direct_delivery",
    });

    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });
    expectFields(snapshot.summary.byType, { "exec.approval.followup_suppressed": 1 });
    expectFields(snapshot.events[0], {
      type: "exec.approval.followup_suppressed",
      approvalId: "approval-123",
      reason: "session_rebound",
      phase: "direct_delivery",
    });
  });

  it("summarizes inbound delivery proof events without message content", () => {
    emitDiagnosticEvent({
      type: "message.received",
      channel: "signal",
      sessionKey: "agent:main:signal:direct:u1",
      messageId: "msg-secret",
      chatId: "chat-secret",
      source: "dispatchInboundMessage",
    });
    emitDiagnosticEvent({
      type: "message.dispatch.started",
      channel: "signal",
      sessionKey: "agent:main:signal:direct:u1",
      source: "replyResolver",
    });
    emitDiagnosticEvent({
      type: "message.dispatch.completed",
      channel: "signal",
      sessionKey: "agent:main:signal:direct:u1",
      source: "replyResolver",
      durationMs: 12,
      outcome: "completed",
    });
    emitDiagnosticEvent({
      type: "session.turn.created",
      runId: "run-1",
      sessionKey: "agent:main:signal:direct:u1",
      sessionId: "session-secret",
      agentId: "main",
      channel: "signal",
      trigger: "user",
    });

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expect(snapshot.summary.byType).toMatchObject({
      "message.received": 1,
      "message.dispatch.started": 1,
      "message.dispatch.completed": 1,
      "session.turn.created": 1,
    });
    expect(snapshot.events).toMatchObject([
      { type: "message.received", channel: "signal", source: "dispatchInboundMessage" },
      { type: "message.dispatch.started", channel: "signal", source: "replyResolver" },
      {
        type: "message.dispatch.completed",
        channel: "signal",
        source: "replyResolver",
        outcome: "completed",
      },
      { type: "session.turn.created", channel: "signal", source: "main", outcome: "user" },
    ]);
    for (const event of snapshot.events) {
      expectAbsent(event, "messageId", "chatId", "sessionId", "sessionKey");
    }
  });

  it("summarizes assembled context diagnostics without prompt text", async () => {
    emitDiagnosticEvent({
      type: "context.assembled",
      runId: "run-secret",
      sessionId: "session-secret",
      provider: "openai",
      model: "gpt-5.4",
      channel: "telegram",
      trigger: "user-message",
      messageCount: 4,
      historyTextChars: 1200,
      historyImageBlocks: 1,
      maxMessageTextChars: 800,
      systemPromptChars: 300,
      promptChars: 100,
      promptImages: 1,
      contextTokenBudget: 200_000,
      reserveTokens: 20_000,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expectFields(snapshot.events[0], {
      type: "context.assembled",
      provider: "openai",
      model: "gpt-5.4",
      channel: "telegram",
      count: 4,
      context: { limit: 200_000 },
    });
    expectAbsent(snapshot.events[0], "runId", "sessionId", "promptChars", "systemPromptChars");
  });

  it("projects run.execution_phase into the dedicated phase fields", async () => {
    emitDiagnosticEvent({
      type: "run.execution_phase",
      runId: "run-1",
      sessionId: "sid-1",
      sessionKey: "sk-1",
      phase: "model_call_started",
      provider: "anthropic",
      model: "claude",
      tool: "read",
      firstModelCallStarted: true,
    });
    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expectFields(snapshot.events[0], {
      type: "run.execution_phase",
      phase: "model_call_started",
      provider: "anthropic",
      model: "claude",
      toolName: "read",
    });
    expect(snapshot.events[0]).not.toHaveProperty("reason");
  });

  it("sanitizes tool and model diagnostic error categories", async () => {
    emitDiagnosticEvent({
      type: "tool.execution.error",
      toolName: "read",
      durationMs: 1,
      errorCategory: "bad reason\nwith content",
    });
    emitDiagnosticEvent({
      type: "model.call.error",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 1,
      requestPayloadBytes: 1234,
      responseStreamBytes: 567,
      timeToFirstByteMs: 89,
      providerProcessingMs: 0.25,
      providerWaitEstimateMs: 0.75,
      errorCategory: "TypeError",
      failureKind: "terminated",
      memory: memory({ externalBytes: 20, arrayBuffersBytes: 10 }),
    });
    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expectFields(snapshot.events[0], { type: "tool.execution.error", toolName: "read" });
    expect(snapshot.events[0]).not.toHaveProperty("reason");
    expectFields(snapshot.events[1], {
      type: "model.call.error",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 1,
      requestBytes: 1234,
      responseBytes: 567,
      timeToFirstByteMs: 89,
      providerProcessingMs: 0.25,
      providerWaitEstimateMs: 0.75,
      reason: "TypeError",
      failureKind: "terminated",
      memory: memory({ externalBytes: 20, arrayBuffersBytes: 10 }),
    });
    expect(JSON.stringify(snapshot.events[1])).not.toContain("call-1");
  });

  it("summarizes memory and large payload events", () => {
    emitDiagnosticEvent({
      type: "diagnostic.memory.sample",
      memory: memory(),
    });
    emitDiagnosticEvent({
      type: "diagnostic.memory.pressure",
      level: "warning",
      reason: "rss_threshold",
      thresholdBytes: 90,
      memory: memory({ rssBytes: 120, heapTotalBytes: 90, heapUsedBytes: 50 }),
    });
    emitDiagnosticEvent({
      type: "payload.large",
      surface: "gateway.http.json",
      action: "rejected",
      bytes: 1024,
      limitBytes: 512,
      reason: "content-length",
    });

    const snapshot = getDiagnosticStabilitySnapshot();

    expectFields(snapshot.summary.memory, {
      maxRssBytes: 120,
      maxHeapUsedBytes: 50,
      pressureCount: 1,
    });
    expectFields(snapshot.summary.memory?.latest, { rssBytes: 120, heapUsedBytes: 50 });
    expect(snapshot.summary.payloadLarge).toEqual({
      count: 1,
      rejected: 1,
      truncated: 0,
      chunked: 0,
      bySurface: { "gateway.http.json": 1 },
    });
  });

  it("keeps the newest events when capacity is exceeded", () => {
    startDiagnosticStabilityRecorder();

    for (let index = 0; index < 1005; index += 1) {
      emitDiagnosticEvent({
        type: "message.queued",
        source: "test",
        queueDepth: index,
      });
    }

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 1000 });

    expect(snapshot.capacity).toBe(1000);
    expect(snapshot.count).toBe(1000);
    expect(snapshot.dropped).toBe(5);
    expect(snapshot.firstSeq).toBe(6);
    expect(snapshot.lastSeq).toBe(1005);
    expectFields(snapshot.events[0], { seq: 6, queueDepth: 5 });
  });

  it("keeps trusted exporter state sticky and rejects spoofed untrusted facts", async () => {
    emitDiagnosticEvent({
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
      emitDiagnosticEvent({ type: "message.queued", source: "test", queueDepth: index });
    }
    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({ type: "telemetry.exporter", limit: 1000 });
    const defaultSnapshot = getDiagnosticStabilitySnapshot({ limit: 1000 });

    expect(snapshot.capacity).toBe(16);
    expect(snapshot.count).toBe(1);
    expect(snapshot.events).toMatchObject([
      {
        type: "telemetry.exporter",
        source: "diagnostics-otel",
        target: "traces",
        transport: "otlp-http-protobuf",
        outcome: "failure",
        reason: "export_failed",
        mode: "default_endpoint",
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("collector.example");
    expect(defaultSnapshot.count).toBe(1000);
    expect(defaultSnapshot.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "message.queued", source: "test" })]),
    );
    expect(defaultSnapshot.events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "telemetry.exporter" })]),
    );
  });

  it("retains exporter ownership through recovery", async () => {
    startExporter({ signal: "metrics", endpointMode: "configured" });
    recordExporter({ signal: "metrics", status: "failure", reason: "export_failed" });
    recordExporter({ signal: "metrics", status: "recovered", reason: "export_failed" });
    await waitForDiagnosticEventsDrained();

    expect(exporterEvents()).toMatchObject([
      {
        target: "metrics",
        outcome: "recovered",
        reason: "export_failed",
        mode: "configured",
      },
    ]);
  });

  it("preserves explicit and dependency-default ownership on startup failures", async () => {
    startDiagnosticStabilityRecorder();

    recordDiagnosticExporterHealth("diagnostics-otel", {
      signal: "traces",
      transport: "otlp-http-protobuf",
      endpointMode: "default_endpoint",
      status: "failure",
      reason: "start_failed",
    });
    recordDiagnosticExporterHealth("diagnostics-otel", {
      signal: "metrics",
      transport: "otlp-http-protobuf",
      endpointMode: "configured",
      status: "failure",
      reason: "start_failed",
    });
    await waitForDiagnosticEventsDrained();

    expect(
      getDiagnosticStabilitySnapshot({
        type: "telemetry.exporter",
        limit: 1000,
      }).events,
    ).toEqual([
      expect.objectContaining({
        target: "traces",
        transport: "otlp-http-protobuf",
        outcome: "failure",
        reason: "start_failed",
        mode: "default_endpoint",
      }),
      expect.objectContaining({
        target: "metrics",
        transport: "otlp-http-protobuf",
        outcome: "failure",
        reason: "start_failed",
        mode: "configured",
      }),
    ]);
  });

  it("keeps safe generic codes while dropping unsafe sources and redacting transports", async () => {
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
    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({ type: "telemetry.exporter", limit: 1000 });
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

  it("replaces retired routes while retaining every current logs both route", async () => {
    startExporter();
    recordExporter({ status: "dropped" });
    startExporter({ transport: "external-sdk" });
    await waitForDiagnosticEventsDrained();

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
    await waitForDiagnosticEventsDrained();

    let events = exporterEvents();
    expect(events.filter((event) => event.target === "traces")).toMatchObject([
      {
        transport: "otlp-http-protobuf",
        outcome: "failure",
        reason: "unsupported_protocol",
      },
    ]);
    expect(events.filter((event) => event.target === "logs")).toMatchObject([
      { transport: "otlp-http-protobuf", outcome: "started" },
      { transport: "stdout", outcome: "started" },
    ]);

    recordExporter({ status: "dropped" });
    startExporter();
    await waitForDiagnosticEventsDrained();

    expect(exporterEvents().filter((event) => event.target === "traces")).toMatchObject([
      { transport: "otlp-http-protobuf", outcome: "started" },
    ]);

    recordExporter({ signal: "logs", status: "dropped" });
    recordExporter({ signal: "logs", transport: "stdout", status: "dropped" });
    startExporter({ signal: "logs", transport: "stdout" });
    await waitForDiagnosticEventsDrained();

    events = exporterEvents();
    expect(events.filter((event) => event.target === "logs")).toMatchObject([
      { transport: "stdout", outcome: "started" },
    ]);

    recordExporter({ signal: "logs", transport: "stdout", status: "dropped" });
    startExporter({ signal: "logs" });
    startExporter({ signal: "logs", transport: "stdout" });
    await waitForDiagnosticEventsDrained();

    events = exporterEvents();
    expect(events.filter((event) => event.target === "logs")).toMatchObject([
      { transport: "otlp-http-protobuf", outcome: "started" },
      { transport: "stdout", outcome: "started" },
    ]);
  });

  it("filters snapshots by type, sequence, and limit", () => {
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });
    emitDiagnosticEvent({ type: "payload.large", surface: "chat.history", action: "truncated" });
    emitDiagnosticEvent({ type: "payload.large", surface: "chat.history", action: "chunked" });

    const snapshot = getDiagnosticStabilitySnapshot({
      type: "payload.large",
      sinceSeq: 2,
      limit: 1,
    });

    expect(snapshot.count).toBe(1);
    expect(snapshot.events).toHaveLength(1);
    expectFields(snapshot.events[0], { seq: 3, type: "payload.large", action: "chunked" });
  });

  it("records sanitized trusted model request instrumentation", async () => {
    startDiagnosticStabilityRecorder();

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "private-run-id",
      callId: "private-call-id",
      sessionKey: "private-session-key",
      provider: "openai",
      model: "gpt-5.4",
      observationUnit: "request",
    });
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticStabilitySnapshot({ type: "model.call.started" }).events).toEqual([
      expect.objectContaining({
        type: "model.call.started",
        provider: "openai",
        model: "gpt-5.4",
      }),
    ]);
    expect(JSON.stringify(getDiagnosticStabilitySnapshot())).not.toContain("private-");
  });

  it("rejects trusted non-model events before copying their payloads", () => {
    const clone = vi.spyOn(globalThis, "structuredClone");

    emitTrustedDiagnosticEvent({ type: "model.usage", usage: { total: 42 } });
    expect(clone).not.toHaveBeenCalled();
    emitDiagnosticEvent({ type: "model.usage", usage: { total: 7 } });

    expect(getDiagnosticStabilitySnapshot().events).toEqual([
      expect.objectContaining({ type: "model.usage", seq: 2, usage: { total: 7 } }),
    ]);
  });

  it("keeps async queue drop summaries after drained queued events for sinceSeq polling", async () => {
    for (let index = 0; index < 10_001; index += 1) {
      emitDiagnosticEvent({
        type: "model.call.started",
        runId: `overflow-run-${index}`,
        callId: `overflow-call-${index}`,
        provider: "openai",
        model: "gpt-5.4",
      });
    }

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const midDrainSnapshot = getDiagnosticStabilitySnapshot({ limit: 1000 });
    expect(midDrainSnapshot.lastSeq).toBe(100);
    expect(
      midDrainSnapshot.events.some((event) => event.type === "diagnostic.async_queue.dropped"),
    ).toBe(false);

    await waitForDiagnosticEventsDrained();

    const sinceMidDrain = getDiagnosticStabilitySnapshot({
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
      maxQueueLength: 10_000,
      drainBatchSize: 100,
    });
    expect(
      sinceMidDrain.events.filter((event) => event.type === "model.call.started"),
    ).not.toHaveLength(0);
    expect(sinceMidDrain.lastSeq).toBeGreaterThan(10_000);
  });

  it("applies query filters to persisted snapshots without mutating the source", () => {
    const snapshot: DiagnosticStabilitySnapshot = {
      generatedAt: "2026-04-22T12:00:00.000Z",
      capacity: 1000,
      count: 3,
      dropped: 0,
      firstSeq: 1,
      lastSeq: 3,
      events: [
        { seq: 1, ts: 1, type: "webhook.received" },
        { seq: 2, ts: 2, type: "payload.large", surface: "chat.history", action: "rejected" },
        { seq: 3, ts: 3, type: "payload.large", surface: "chat.history", action: "chunked" },
      ],
      summary: {
        byType: { "webhook.received": 1, "payload.large": 2 },
      },
    };

    const selected = selectDiagnosticStabilitySnapshot(snapshot, {
      type: "payload.large",
      limit: 1,
    });

    expectFields(selected, { count: 2, firstSeq: 2, lastSeq: 3 });
    expect(selected.events).toHaveLength(1);
    expectFields(selected.events[0], { seq: 3, type: "payload.large", action: "chunked" });
    expectFields(selected.summary.byType, { "payload.large": 2 });
    expectFields(selected.summary.payloadLarge, { count: 2, rejected: 1, chunked: 1 });
    expect(snapshot.events).toHaveLength(3);
  });

  it("normalizes external stability query params consistently", () => {
    expect(
      normalizeDiagnosticStabilityQuery(
        { limit: "25", type: " payload.large ", sinceSeq: "2" },
        { defaultLimit: 10 },
      ),
    ).toEqual({ limit: 25, type: "payload.large", sinceSeq: 2 });
    expect(normalizeDiagnosticStabilityQuery({}, { defaultLimit: 10 })).toEqual({
      limit: 10,
      type: undefined,
      sinceSeq: undefined,
    });
    expectQueryError({ limit: 0 }, "limit must be between 1 and 1000");
    expectQueryError({ sinceSeq: -1 }, "sinceSeq must be a non-negative integer");
  });

  it("rejects blank stability query limit, sinceSeq, and type", () => {
    expectQueryError({ limit: "" }, "limit must be a non-negative integer");
    expectQueryError({ sinceSeq: "" }, "sinceSeq must be a non-negative integer");
    expectQueryError({ type: "" }, "type must be a non-empty string");
    expectQueryError({ type: "   " }, "type must be a non-empty string");
  });

  it("rejects non-decimal stability query integer strings", () => {
    for (const malformed of ["0x2", "1e2", "+5", " 5 "]) {
      expectQueryError({ limit: malformed }, "limit must be a non-negative integer");
      expectQueryError({ sinceSeq: malformed }, "sinceSeq must be a non-negative integer");
    }
    expect(normalizeDiagnosticStabilityQuery({ sinceSeq: "0" }).sinceSeq).toBe(0);
    expect(normalizeDiagnosticStabilityQuery({ limit: "42" }).limit).toBe(42);
    expect(normalizeDiagnosticStabilityQuery({ limit: 7 }).limit).toBe(7);
  });

  it("rejects unsafe integers for stability query limit and sinceSeq", () => {
    const safe = Number.MAX_SAFE_INTEGER;
    const unsafe = safe + 1;
    // sinceSeq has no upper bound: safe integers are accepted, unsafe rejected.
    expect(normalizeDiagnosticStabilityQuery({ sinceSeq: safe }).sinceSeq).toBe(safe);
    expectQueryError({ sinceSeq: unsafe }, "sinceSeq must be a non-negative integer");
    expect(normalizeDiagnosticStabilityQuery({ sinceSeq: String(safe) }).sinceSeq).toBe(safe);
    expectQueryError({ sinceSeq: String(unsafe) }, "sinceSeq must be a non-negative integer");
    // limit is additionally capped at 1000: a safe but out-of-range value hits
    // the range error, while an unsafe integer is rejected by the integer gate
    // first, identically for numeric and string input.
    expectQueryError({ limit: safe }, "limit must be between 1 and 1000");
    expectQueryError({ limit: unsafe }, "limit must be a non-negative integer");
    expectQueryError({ limit: String(unsafe) }, "limit must be a non-negative integer");
  });

  it("records a bounded payload-free projection of diagnostic events", async () => {
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
    emitDiagnosticEvent({
      type: "webhook.error",
      channel: "telegram",
      chatId: "chat-secret",
      error: "raw upstream error with content",
    });
    emitDiagnosticEvent({
      ...tool,
      sessionId: "session-1",
      message: "message that should not be stored",
    });
    emitDiagnosticEvent({
      ...talk,
      sessionId: "talk-session-secret",
      turnId: "talk-turn-secret",
      captureId: "talk-capture-secret",
      byteLength: 345,
    });
    emitInternalDiagnosticEvent({
      type: "diagnostic.child_process.spawn",
      family: "node",
      count: 2,
      intervalMs: 60_000,
    });
    emitInternalDiagnosticEvent({ type: "gateway.http.cancelled", source: "client" });
    emitDiagnosticEvent({
      type: "worker.request",
      kind: "sessionTranscript",
      requestClass: "task",
      phase: "queued",
      queueDepth: 1,
    });
    emitDiagnosticEvent({ type: "secret.egress", outcome: "forwarded", substituted: false });
    emitDiagnosticEvent({
      type: "tool.catalog",
      source: "builtin",
      mode: "code-mode",
      toolCount: 12,
    });
    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expect(snapshot).toMatchObject({
      count: 3,
      summary: {
        byType: {
          "webhook.error": 1,
          "tool.loop": 1,
          "talk.event": 1,
        },
      },
      events: [{ type: "webhook.error", channel: "telegram" }, tool, { ...talk, bytes: 345 }],
    });
    for (const [index, keys] of [
      ["error", "chatId"],
      ["message", "sessionId", "sessionKey"],
      ["sessionId", "turnId", "captureId"],
    ].entries()) {
      expectAbsent(snapshot.events[index], ...keys);
    }
  });
});
