import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getRecentDiagnosticPhases,
  resetDiagnosticPhasesForTest,
  withDiagnosticPhase,
} from "../logging/diagnostic-phase.js";
import {
  createQueuedDiagnosticPhaseEmitter,
  emitTrustedDiagnosticEvent,
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "./diagnostic-events.js";
import { runWithDiagnosticTraceContext } from "./diagnostic-trace-context.js";

const trace = { traceId: "1234567890abcdef1234567890abcdef", spanId: "1234567890abcdef" };
const phase = { name: "runtime.fixture", startedAt: 10, endedAt: 20, durationMs: 10 };

describe("queued runtime diagnostic phases", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticPhasesForTest();
  });
  afterEach(async () => {
    await waitForDiagnosticEventsDrained();
    resetDiagnosticEventsForTest();
    resetDiagnosticPhasesForTest();
  });

  it("preserves synchronous startup history and queues owned runtime snapshots with their captured trace", async () => {
    const events: DiagnosticEventPayload[] = [];
    const publicEvents: DiagnosticEventPayload[] = [];
    onDiagnosticEvent((event) => publicEvents.push(event));
    onTrustedInternalDiagnosticEvent((event) => events.push(event));
    await withDiagnosticPhase("startup.fixture", () => undefined);
    expect(events.map((event) => event.type)).toEqual(["diagnostic.phase.completed"]);
    expect(getRecentDiagnosticPhases().map((entry) => entry.name)).toEqual(["startup.fixture"]);

    const bound = runWithDiagnosticTraceContext(trace, createQueuedDiagnosticPhaseEmitter)!;
    const parentless = runWithDiagnosticTraceContext(
      undefined,
      createQueuedDiagnosticPhaseEmitter,
    )!;
    const details = { threadCpuMs: 3 };
    runWithDiagnosticTraceContext(trace, () => {
      parentless({ ...phase, name: "runtime.parentless" });
      bound({ ...phase, details });
    });
    details.threadCpuMs = 999;
    expect(events).toHaveLength(1);
    await waitForDiagnosticEventsDrained();

    expect(events[1]).toMatchObject({ name: "runtime.parentless", trace: undefined });
    expect(events[2]).toMatchObject({ ...phase, trace, details: { threadCpuMs: 3 } });
    expect(publicEvents).toHaveLength(1);
    expect(getRecentDiagnosticPhases().map((entry) => entry.name)).toEqual(["startup.fixture"]);
  });

  it("requires a currently interested trusted consumer and respects disabled diagnostics", async () => {
    const events: DiagnosticEventPayload[] = [];
    onInternalDiagnosticEvent((event) => events.push(event));
    onTrustedInternalDiagnosticEvent(() => {}, { includeTrusted: ["gateway.rpc"] });
    expect(createQueuedDiagnosticPhaseEmitter()).toBeUndefined();
    const stop = onTrustedInternalDiagnosticEvent(() => {}, {
      include: ["diagnostic.phase.completed"],
    });
    setDiagnosticsEnabledForProcess(false);
    expect(createQueuedDiagnosticPhaseEmitter()).toBeUndefined();
    setDiagnosticsEnabledForProcess(true);
    const emit = createQueuedDiagnosticPhaseEmitter()!;
    setDiagnosticsEnabledForProcess(false);
    emit(phase);
    setDiagnosticsEnabledForProcess(true);
    stop();
    emit(phase);
    await waitForDiagnosticEventsDrained();
    expect(events).toEqual([]);
  });

  it("uses the bounded diagnostic queue without displacing required lifecycle terminals", async () => {
    const events: DiagnosticEventPayload[] = [];
    onTrustedInternalDiagnosticEvent((event) => events.push(event));
    const emit = createQueuedDiagnosticPhaseEmitter()!;
    for (let index = 0; index < 10_001; index++) {
      emit(phase);
    }
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      toolName: "exec",
      durationMs: 1,
    });
    expect(events).toHaveLength(0);
    await waitForDiagnosticEventsDrained();
    expect(events.filter((event) => event.type === "diagnostic.phase.completed")).toHaveLength(
      9_999,
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.execution.completed" }));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "diagnostic.async_queue.dropped",
        droppedTrustedEvents: 2,
        maxQueueLength: 10_000,
        drainBatchSize: 100,
      }),
    );
  });
});
