import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
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
const BLOCKED_KEYS = ["__proto__", "constructor", "prototype"];
type LogRecord = Extract<DiagnosticEventPayload, { type: "log.record" }>;

async function logRecord(write: () => void) {
  const received: Array<{ event: LogRecord; metadata: DiagnosticEventMetadata }> = [];
  onInternalDiagnosticEvent((event, metadata) => {
    if (event.type === "log.record") {
      received.push({ event, metadata });
    }
  });
  write();
  await waitForDiagnosticEventsDrained();
  expect(received).toHaveLength(1);
  return expectDefined(received[0], "log record");
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
  resetLogger();
  vi.restoreAllMocks();
});

it("keeps log records out of public diagnostic listeners", async () => {
  const listener = vi.fn();
  onDiagnosticEvent(listener);
  getChildLogger().info("public listener ignores this log");
  await waitForDiagnosticEventsDrained();
  expect(listener).not.toHaveBeenCalled();
});

it("uses active request trace context for unbound log records", async () => {
  const trace = createDiagnosticTraceContext({ traceId: TRACE_ID, spanId: SPAN_ID });
  const { event, metadata } = await logRecord(() =>
    runWithDiagnosticTraceContext(trace, () =>
      getChildLogger().info("request-scoped diagnostic log"),
    ),
  );
  expect(event.trace).toEqual(trace);
  expect(metadata).toMatchObject({ trusted: false, trustedTraceContext: true });
});

it("redacts and bounds internal log messages and attributes", async () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456"; // pragma: allowlist secret
  const secretKey = "sk-1234567890abcdef1234567890abcdef"; // pragma: allowlist secret
  const structured: Record<string, unknown> = Object.assign(Object.create(null), {
    safe: "ok",
    token: secret,
    password: "hunter2",
    longValue: "x".repeat(5000),
    nested: { secret },
    "bad key": "drop-me",
    [secretKey]: "secret-key",
  });
  for (const key of BLOCKED_KEYS) {
    structured[key] = "pollute";
  }
  for (let index = 0; index < 1000; index += 1) {
    structured[`extra${index}`] = index;
  }
  const { event } = await logRecord(() =>
    toPinoLikeLogger(tracedLogger(), "info").info(
      structured,
      { raw: secret },
      `secret=${secret} ${"y".repeat(5000)}`,
    ),
  );
  const attributes = event.attributes ?? {};
  expect(event.message).not.toContain(secret);
  expect(event.message.length).toBeLessThanOrEqual(4200);
  expect(attributes.password).toBe("***");
  expect(String(attributes.token)).toContain("…");
  expect(String(attributes.longValue).length).toBeLessThanOrEqual(2100);
  expect(attributes.safe).toBe("ok");
  expect(Object.keys(attributes)).toHaveLength(32);
  expectAbsentKeys(attributes, ["nested", "bad key", secretKey, ...BLOCKED_KEYS]);
  expectAbsentKeys(event, ["argsJson"]);
});
