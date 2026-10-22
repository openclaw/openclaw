import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { getChildLogger, resetLogger, setLoggerOverride, toPinoLikeLogger } from "./logger.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const PROTO_KEY = "__proto__";
type LogRecord = Extract<DiagnosticEventPayload, { type: "log.record" }>;

async function logRecord(write: () => void) {
  const received: Array<{ event: LogRecord; metadata: DiagnosticEventMetadata }> = [];
  const unsubscribe = onInternalDiagnosticEvent((event, metadata) => {
    if (event.type === "log.record") {
      received.push({ event, metadata });
    }
  });
  try {
    write();
    await yieldToEventLoop();
    expect(received).toHaveLength(1);
    return expectDefined(received[0], "log record");
  } finally {
    unsubscribe();
  }
}

function tracedLogger() {
  return getChildLogger({ subsystem: "diagnostic", trace: { traceId: TRACE_ID, spanId: SPAN_ID } });
}

function expectAbsentKeys(object: object, keys: string[]) {
  for (const key of keys) {
    expect(Object.hasOwn(object, key)).toBe(false);
  }
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
  vi.restoreAllMocks();
});

it("does not build or queue log records for a public-only listener", async () => {
  const listener = vi.fn();
  const unsubscribe = onDiagnosticEvent(listener);
  const structuredCloneSpy = vi.spyOn(globalThis, "structuredClone");

  getChildLogger({ subsystem: "diagnostic" }).info("public listener ignores this log");
  await yieldToEventLoop();
  unsubscribe();

  expect(listener).not.toHaveBeenCalled();
  expect(structuredCloneSpy).not.toHaveBeenCalled();
});

it("uses active request trace context for unbound log records", async () => {
  const trace = createDiagnosticTraceContext({ traceId: TRACE_ID, spanId: SPAN_ID });
  const { event, metadata } = await logRecord(() =>
    runWithDiagnosticTraceContext(trace, () =>
      getChildLogger({ subsystem: "diagnostic" }).info(
        { runId: "run-1" },
        "request-scoped diagnostic log",
      ),
    ),
  );
  expect(event.trace).toEqual(trace);
  expect(metadata).toMatchObject({ trusted: false, trustedTraceContext: true });
});

it("redacts and bounds internal log records before diagnostic emission", async () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456"; // pragma: allowlist secret
  const { event } = await logRecord(() =>
    toPinoLikeLogger(tracedLogger(), "info").info(
      {
        token: secret,
        password: "hunter2",
        longValue: "x".repeat(5000),
        nested: { secret },
        "bad key": "drop-me",
      },
      { raw: secret },
      `secret=${secret} ${"y".repeat(5000)}`,
    ),
  );
  expect(event.message).not.toContain(secret);
  expect(event.message.length).toBeLessThanOrEqual(4200);
  expect(event.attributes?.token).not.toBe(secret);
  expect(event.attributes?.password).toBe("***");
  expect(JSON.stringify(event)).not.toContain("hunter2");
  expect(String(event.attributes?.token)).toContain("…");
  expect(String(event.attributes?.longValue).length).toBeLessThanOrEqual(2100);
  expectAbsentKeys(event.attributes ?? {}, ["nested", "bad key"]);
  expectAbsentKeys(event, ["argsJson"]);
});

it("drops sensitive, blocked, and excess log attribute keys without copying large objects", async () => {
  const structured = Object.create(null) as Record<string, unknown>;
  structured.safe = "ok";
  structured[PROTO_KEY] = "pollute";
  structured["constructor"] = "pollute";
  structured["prototype"] = "pollute";
  structured["sk-1234567890abcdef1234567890abcdef"] = "secret-key"; // pragma: allowlist secret
  for (let index = 0; index < 1000; index += 1) {
    structured[`extra${index}`] = index;
  }

  const { event } = await logRecord(() => tracedLogger().info(structured, "bounded attrs"));
  const attributes = event.attributes ?? {};
  expect(attributes.safe).toBe("ok");
  expect(Object.keys(attributes)).toHaveLength(32);
  expectAbsentKeys(attributes, [
    PROTO_KEY,
    "constructor",
    "prototype",
    "sk-1234567890abcdef1234567890abcdef", // pragma: allowlist secret
  ]);
});
