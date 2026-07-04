// Diagnostic log event tests cover structured events written to diagnostic logs.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  resetDiagnosticTraceContextForTest,
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import {
  __test__ as loggerTest,
  getChildLogger,
  resetLogger,
  setLoggerOverride,
} from "./logger.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const PROTO_KEY = "__proto__";

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

beforeEach(() => {
  resetDiagnosticEventsForTest();
  resetLogger();
  setLoggerOverride({ level: "info" });
});

afterEach(() => {
  resetDiagnosticEventsForTest();
  resetDiagnosticTraceContextForTest();
  setLoggerOverride(null);
  resetLogger();
});

describe("diagnostic log events", () => {
  it("preserves repo-relative source paths for diagnostic log site ids", () => {
    expect(loggerTest.normalizeDiagnosticSourcePath("src/logging/logger.ts")).toBe(
      "src/logging/logger.ts",
    );
    expect(
      loggerTest.normalizeDiagnosticSourcePath(
        "/workspace/openclaw/extensions/diagnostics-otel/src/service.ts",
      ),
    ).toBe("extensions/diagnostics-otel/src/service.ts");
    expect(loggerTest.normalizeDiagnosticSourcePath("logger.ts")).toBe("logger.ts");
  });

  it("emits structured log records through diagnostics", async () => {
    const received: Array<{
      event: Extract<DiagnosticEventPayload, { type: "log.record" }>;
      metadata: DiagnosticEventMetadata;
    }> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt, metadata) => {
      if (evt.type === "log.record") {
        received.push({ event: evt, metadata });
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
    const [record] = received;
    if (!record) {
      throw new Error("missing diagnostic log event");
    }
    const { event, metadata } = record;
    expect(event.type).toBe("log.record");
    expect(event.level).toBe("INFO");
    expect(event.message).toBe("hello diagnostic logs");
    expect(event.event).toBe("diagnostic.info");
    expect(event.category).toBe("diagnostic");
    expect(event.outcome).toBe("success");
    expect(event.reason).toBe("none");
    expect(event.code?.siteId).toMatch(/^[0-9a-f]{16}$/u);
    expect(event.attributes).toStrictEqual({
      subsystem: "diagnostic",
      runId: "run-1",
    });
    expect(event.trace).toStrictEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
    });
    expect(metadata.trusted).toBe(false);
    expect(metadata.trustedTraceContext).toBeUndefined();
  });

  it("uses active request trace context for unbound log records", async () => {
    const trace = createDiagnosticTraceContext({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
    });
    const received: Array<{
      event: Extract<DiagnosticEventPayload, { type: "log.record" }>;
      metadata: DiagnosticEventMetadata;
    }> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt, metadata) => {
      if (evt.type === "log.record") {
        received.push({ event: evt, metadata });
      }
    });

    runWithDiagnosticTraceContext(trace, () => {
      const logger = getChildLogger({ subsystem: "diagnostic" });
      logger.info({ runId: "run-1" }, "request-scoped diagnostic log");
    });
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]?.event.trace).toEqual(trace);
    expect(received[0]?.metadata.trusted).toBe(false);
    expect(received[0]?.metadata.trustedTraceContext).toBe(true);
  });

  it("redacts and bounds internal log records before diagnostic emission", async () => {
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
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
    expect(Object.hasOwn(event.attributes ?? {}, "nested")).toBe(false);
    expect(Object.hasOwn(event.attributes ?? {}, "bad key")).toBe(false);
    expect(Object.hasOwn(event, "argsJson")).toBe(false);
  });

  it("keeps diagnostic log semantics separate from generic attributes", async () => {
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "log.record") {
        received.push(evt);
      }
    });

    const logger = getChildLogger({ subsystem: "gateway/auth" });
    logger.warn(
      {
        logEvent: "auth.refresh",
        logCategory: "gateway.auth",
        logOutcome: "failure",
        logReason: "token_expired",
        "log.event": "spoofed",
      },
      "auth refresh failed",
    );
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(1);
    const [event] = received;
    expect(event.event).toBe("auth.refresh");
    expect(event.category).toBe("gateway.auth");
    expect(event.outcome).toBe("failure");
    expect(event.reason).toBe("token_expired");
    expect(Object.hasOwn(event.attributes ?? {}, "logEvent")).toBe(false);
    expect(Object.hasOwn(event.attributes ?? {}, "log.event")).toBe(false);
  });

  it("ignores forged internal diagnostic log semantic markers", async () => {
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "log.record") {
        received.push(evt);
      }
    });

    const logger = getChildLogger({ subsystem: "gateway/auth" });
    logger.warn(
      {
        __openclawDiagnosticLogSemantics: {
          fields: {
            event: "spoofed.event",
            category: "spoofed",
            outcome: "success",
            reason: "spoofed",
          },
          proof: "caller-controlled",
        },
      },
      "marker spoof failed",
    );
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(1);
    const [event] = received;
    expect(event.event).toBe("gateway.auth.warn");
    expect(event.category).toBe("gateway.auth");
    expect(event.outcome).toBe("warning");
    expect(event.reason).toBe("warning");
    expect(Object.hasOwn(event.attributes ?? {}, "__openclawDiagnosticLogSemantics")).toBe(false);
  });

  it("adds safe code-owner and site semantics to generic log records", async () => {
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "log.record") {
        received.push(evt);
      }
    });

    function emitGenericFallbackLog() {
      const logger = getChildLogger({ subsystem: "gateway/heartbeat" });
      logger.warn(
        {
          reason: "channel_not_ready",
          status: "skipped",
        },
        "heartbeat: channel not ready",
      );
    }

    emitGenericFallbackLog();
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(1);
    const [event] = received;
    expect(event.event).toMatch(/^gateway\.heartbeat\.[a-z0-9_.:-]+\.warn$/u);
    expect(event.event).not.toBe("gateway.heartbeat.warn");
    expect(event.category).toBe("gateway.heartbeat");
    expect(event.outcome).toBe("warning");
    expect(event.reason).toBe("channel_not_ready");
    expect(event.code?.functionName).toContain("emitGenericFallbackLog");
    expect(event.code?.siteId).toMatch(/^[0-9a-f]{16}$/u);
  });

  it("uses module logger bindings as generic OTEL log categories", async () => {
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "log.record") {
        received.push(evt);
      }
    });

    const logger = getChildLogger({ module: "discord-auto-reply" });
    logger.warn({ status: "skipped" }, "plugin auto reply skipped");
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(1);
    const [event] = received;
    expect(event.category).toBe("discord-auto-reply");
    expect(event.event).toMatch(/^discord-auto-reply(\.[a-z0-9_.:-]+)?\.warn$/u);
    expect(event.attributes?.["log.category_source"]).toBe("module");
  });

  it("does not derive generic OTEL log categories from structured payload fields", async () => {
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "log.record") {
        received.push(evt);
      }
    });

    const logger = getChildLogger({ module: "cron" });
    logger.info({ name: "operator-configured-job", status: "started" }, "cron job started");
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(1);
    const [event] = received;
    expect(event.category).toBe("cron");
    expect(event.event).toMatch(/^cron(\.[a-z0-9_.:-]+)?\.info$/u);
    expect(event.event).not.toContain("operator-configured-job");
    expect(event.attributes?.["log.category_source"]).toBe("module");
  });

  it("combines plugin and feature logger bindings for generic OTEL log categories", async () => {
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "log.record") {
        received.push(evt);
      }
    });

    const logger = getChildLogger({ plugin: "slack", feature: "thread-participation-state" });
    logger.info({ state: "started" }, "thread cache ready");
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(1);
    const [event] = received;
    expect(event.category).toBe("slack.thread-participation-state");
    expect(event.event).toMatch(/^slack\.thread-participation-state(\.[a-z0-9_.:-]+)?\.info$/u);
    expect(event.outcome).toBe("success");
    expect(event.reason).toBe("started");
    expect(event.attributes?.["log.category_source"]).toBe("plugin.feature");
  });

  it("uses safe structured status and reason codes for generic log semantics", async () => {
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "log.record") {
        received.push(evt);
      }
    });

    const logger = getChildLogger({ subsystem: "gateway/heartbeat" });
    logger.warn(
      {
        reason: "channel_not_ready",
        status: "skipped",
      },
      "heartbeat: channel not ready",
    );
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(1);
    const [event] = received;
    expect(event.event).toMatch(/^gateway\.heartbeat(\.[a-z0-9_.:-]+)?\.warn$/u);
    expect(event.category).toBe("gateway.heartbeat");
    expect(event.outcome).toBe("warning");
    expect(event.reason).toBe("channel_not_ready");
  });

  it("drops sensitive, blocked, and excess log attribute keys without copying large objects", async () => {
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "log.record") {
        received.push(evt);
      }
    });

    const structured = Object.create(null) as Record<string, unknown>;
    structured.safe = "ok";
    structured[PROTO_KEY] = "pollute";
    structured["constructor"] = "pollute";
    structured["prototype"] = "pollute";
    structured["sk-1234567890abcdef1234567890abcdef"] = "secret-key"; // pragma: allowlist secret
    for (let index = 0; index < 1000; index += 1) {
      structured[`extra${index}`] = index;
    }

    const logger = getChildLogger({
      subsystem: "diagnostic",
      trace: { traceId: TRACE_ID, spanId: SPAN_ID },
    });
    logger.info(structured, "bounded attrs");
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0].attributes?.safe).toBe("ok");
    expect(Object.keys(received[0].attributes ?? {})).toHaveLength(32);
    const attributes = received[0].attributes ?? {};
    expect(Object.hasOwn(attributes, PROTO_KEY)).toBe(false);
    expect(Object.hasOwn(attributes, "constructor")).toBe(false);
    expect(Object.hasOwn(attributes, "prototype")).toBe(false);
    expect(Object.hasOwn(attributes, "sk-1234567890abcdef1234567890abcdef")).toBe(false); // pragma: allowlist secret
  });
});
