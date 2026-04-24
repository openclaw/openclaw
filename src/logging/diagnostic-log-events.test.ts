import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { getChildLogger, resetLogger, setLoggerOverride } from "./logger.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  resetDiagnosticEventsForTest();
  resetLogger();
  setLoggerOverride({ level: "info" });
});

afterEach(() => {
  resetDiagnosticEventsForTest();
  setLoggerOverride(null);
  resetLogger();
});

describe("diagnostic log events", () => {
  it("emits structured log records through diagnostics", async () => {
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onDiagnosticEvent((evt) => {
      if (evt.type === "log.record") {
        received.push(evt);
      }
    });

    const logger = getChildLogger({
      subsystem: "diagnostic",
      trace: { traceId: TRACE_ID, spanId: SPAN_ID },
    });
    logger.info({ runId: "run-1" }, "hello diagnostic logs");
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "log.record",
      level: "INFO",
      message: "hello diagnostic logs",
      attributes: {
        subsystem: "diagnostic",
        runId: "run-1",
      },
      trace: {
        traceId: TRACE_ID,
        spanId: SPAN_ID,
      },
    });
  });

  it("redacts and bounds plugin-visible log records before diagnostic emission", async () => {
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onDiagnosticEvent((evt) => {
      if (evt.type === "log.record") {
        received.push(evt);
      }
    });

    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456"; // pragma: allowlist secret
    const logger = getChildLogger({
      subsystem: "diagnostic",
      trace: { traceId: TRACE_ID, spanId: SPAN_ID },
    });
    logger.info(
      {
        token: secret,
        longValue: "x".repeat(5000),
        nested: { secret },
        "bad key": "drop-me",
      },
      { raw: secret },
      `secret=${secret} ${"y".repeat(5000)}`,
    );
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(1);
    const [event] = received;
    expect(event.message).not.toContain(secret);
    expect(event.message.length).toBeLessThanOrEqual(4200);
    expect(event.attributes?.token).not.toBe(secret);
    expect(String(event.attributes?.token)).toContain("…");
    expect(String(event.attributes?.longValue).length).toBeLessThanOrEqual(2100);
    expect(event.attributes).toEqual(
      expect.not.objectContaining({
        nested: expect.anything(),
        "bad key": expect.anything(),
      }),
    );
    expect(event).toEqual(
      expect.not.objectContaining({
        argsJson: expect.anything(),
      }),
    );
  });
});
