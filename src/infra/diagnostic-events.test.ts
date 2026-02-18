import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "./diagnostic-events.js";

describe("diagnostic-events trace context", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  test("trace context fields pass through on model.usage events", () => {
    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    const traceId = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
    const parentSpanId = "abcdef0123456789";

    emitDiagnosticEvent({
      type: "model.usage",
      channel: "telegram",
      provider: "anthropic",
      model: "claude-opus-4-6",
      usage: { input: 100, output: 50 },
      traceId,
      parentSpanId,
    });

    unsub();

    expect(events).toHaveLength(1);
    expect(events[0].traceId).toBe(traceId);
    expect(events[0].parentSpanId).toBe(parentSpanId);
    expect(events[0].ts).toBeGreaterThan(0);
    expect(events[0].seq).toBe(1);
  });

  test("trace context fields pass through on message.processed events", () => {
    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    const traceId = "00112233445566778899aabbccddeeff";
    const parentSpanId = "1122334455667788";

    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      outcome: "completed",
      durationMs: 1200,
      traceId,
      parentSpanId,
    });

    unsub();

    expect(events).toHaveLength(1);
    expect(events[0].traceId).toBe(traceId);
    expect(events[0].parentSpanId).toBe(parentSpanId);
  });

  test("trace context fields are optional and default to undefined", () => {
    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    emitDiagnosticEvent({
      type: "model.usage",
      channel: "discord",
      provider: "openai",
      model: "gpt-4o",
      usage: { input: 200, output: 100 },
    });

    unsub();

    expect(events).toHaveLength(1);
    expect(events[0].traceId).toBeUndefined();
    expect(events[0].parentSpanId).toBeUndefined();
  });

  test("trace context fields pass through on message.queued events", () => {
    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    const traceId = "aabbccdd11223344aabbccdd11223344";

    emitDiagnosticEvent({
      type: "message.queued",
      channel: "telegram",
      source: "telegram",
      traceId,
    });

    unsub();

    expect(events).toHaveLength(1);
    expect(events[0].traceId).toBe(traceId);
  });

  test("seq increments across events", () => {
    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    emitDiagnosticEvent({
      type: "webhook.received",
      channel: "telegram",
      traceId: "aaaa0000bbbb1111cccc2222dddd3333",
    });
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      outcome: "completed",
      traceId: "aaaa0000bbbb1111cccc2222dddd3333",
      parentSpanId: "1234567890abcdef",
    });

    unsub();

    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
  });
});
