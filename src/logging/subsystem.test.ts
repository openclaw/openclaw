// Subsystem logger tests cover per-subsystem log routing and filtering.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { setConsoleSubsystemFilter, shouldLogSubsystemToConsole } from "./console.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { resetLogger, setLoggerOverride } from "./logger.js";
import { loggingState } from "./state.js";
import { createSubsystemLogger } from "./subsystem.js";

const logPathTracker = createSuiteLogPathTracker("openclaw-subsystem-log-");

function installConsoleMethodSpy(method: "log" | "warn" | "error") {
  const spy = vi.fn();
  loggingState.rawConsole = {
    log: method === "log" ? spy : vi.fn(),
    info: vi.fn(),
    warn: method === "warn" ? spy : vi.fn(),
    error: method === "error" ? spy : vi.fn(),
  };
  return spy;
}

function firstMockArgAsString(mock: { mock: { calls: readonly unknown[][] } }): string {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected console mock call");
  }
  return String(call[0]);
}

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function emitFirstSubsystemSourceLog() {
  createSubsystemLogger("gateway/heartbeat").warn("first subsystem source log");
}

function emitSecondSubsystemSourceLog() {
  createSubsystemLogger("gateway/heartbeat").warn("second subsystem source log");
}

beforeAll(async () => {
  await logPathTracker.setup();
});

beforeEach(() => {
  resetDiagnosticEventsForTest();
});

afterEach(() => {
  setConsoleSubsystemFilter(null);
  resetDiagnosticEventsForTest();
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

afterAll(async () => {
  await logPathTracker.cleanup();
});

describe("createSubsystemLogger().isEnabled", () => {
  it("returns true for any/file when only file logging would emit", () => {
    setLoggerOverride({ level: "debug", consoleLevel: "silent" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("debug")).toBe(true);
    expect(log.isEnabled("debug", "file")).toBe(true);
    expect(log.isEnabled("debug", "console")).toBe(false);
  });

  it("returns true for any/console when only console logging would emit", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "debug" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("debug")).toBe(true);
    expect(log.isEnabled("debug", "console")).toBe(true);
    expect(log.isEnabled("debug", "file")).toBe(false);
  });

  it("uses threshold ordering for non-equal console levels", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "fatal" });
    const fatalOnly = createSubsystemLogger("agent/embedded");

    expect(fatalOnly.isEnabled("error", "console")).toBe(false);
    expect(fatalOnly.isEnabled("fatal", "console")).toBe(true);

    setLoggerOverride({ level: "silent", consoleLevel: "trace" });
    const traceLogger = createSubsystemLogger("agent/embedded");

    expect(traceLogger.isEnabled("debug", "console")).toBe(true);
  });

  it("never treats silent as an emittable console level", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("silent", "console")).toBe(false);
  });

  it("returns false when neither console nor file logging would emit", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "silent" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("debug")).toBe(false);
    expect(log.isEnabled("debug", "console")).toBe(false);
    expect(log.isEnabled("debug", "file")).toBe(false);
  });

  it("honors console subsystem filters for console target", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    setConsoleSubsystemFilter(["gateway"]);
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("info", "console")).toBe(false);
  });

  it("does not apply console subsystem filters to file target", () => {
    setLoggerOverride({ level: "info", consoleLevel: "silent" });
    setConsoleSubsystemFilter(["gateway"]);
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("info", "file")).toBe(true);
    expect(log.isEnabled("info")).toBe(true);
  });

  it("treats missing subsystem labels as non-matches when filters are active", () => {
    setConsoleSubsystemFilter(["gateway"]);

    expect(shouldLogSubsystemToConsole(undefined as unknown as string)).toBe(false);
  });

  it("disables console logging when a malformed subsystem logger checks enablement", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    setConsoleSubsystemFilter(["gateway"]);
    const log = createSubsystemLogger(undefined as unknown as string);

    expect(log.isEnabled("info", "console")).toBe(false);
  });

  it("falls back to an unknown subsystem label when a malformed logger emits", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger(undefined as unknown as string);

    log.warn("missing subsystem label");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(firstMockArgAsString(warn)).toContain("[unknown]");
  });

  it("suppresses probe warnings for embedded subsystems based on structured run metadata", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("agent/embedded").child("failover");

    log.warn("embedded run failover decision", {
      runId: "probe-test-run",
      consoleMessage: "embedded run failover decision",
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("does not suppress probe errors for embedded subsystems", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    const error = installConsoleMethodSpy("error");
    const log = createSubsystemLogger("agent/embedded").child("failover");

    log.error("embedded run failover decision", {
      runId: "probe-test-run",
      consoleMessage: "embedded run failover decision",
    });

    expect(error).toHaveBeenCalledTimes(1);
  });

  it("suppresses probe warnings for model-fallback child subsystems based on structured run metadata", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("model-fallback").child("decision");

    log.warn("model fallback decision", {
      runId: "probe-test-run",
      consoleMessage: "model fallback decision",
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("does not suppress probe errors for model-fallback child subsystems", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    const error = installConsoleMethodSpy("error");
    const log = createSubsystemLogger("model-fallback").child("decision");

    log.error("model fallback decision", {
      runId: "probe-test-run",
      consoleMessage: "model fallback decision",
    });

    expect(error).toHaveBeenCalledTimes(1);
  });

  it("still emits non-probe warnings for embedded subsystems", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("agent/embedded").child("auth-profiles");

    log.warn("auth profile failure state updated", {
      runId: "run-123",
      consoleMessage: "auth profile failure state updated",
    });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("still emits non-probe model-fallback child warnings", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("model-fallback").child("decision");

    log.warn("model fallback decision", {
      runId: "run-123",
      consoleMessage: "model fallback decision",
    });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("redacts sensitive tokens at the console sink so subsystem writes do not leak secrets (#73284)", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("gateway");
    const secret = "sk-supersecretvaluefortest12345";

    log.warn(`token=${secret}`);

    expect(warn).toHaveBeenCalledTimes(1);
    const written = firstMockArgAsString(warn);
    expect(written).not.toContain(secret);
    expect(written).toMatch(/sk-sup…2345|\*\*\*/);
  });

  it("redacts Bearer tokens on subsystem error console writes", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    const error = installConsoleMethodSpy("error");
    const log = createSubsystemLogger("gateway").child("auth");
    const bearer = "Bearer abcdefghijklmnopqrstuvwxyz";

    log.error(`Authorization failed: ${bearer}`);

    expect(error).toHaveBeenCalledTimes(1);
    const written = firstMockArgAsString(error);
    expect(written).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(written).toContain("Bearer ");
  });

  it("redacts before colorizing subsystem console messages so ANSI reset codes survive", () => {
    vi.stubEnv("FORCE_COLOR", "1");
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const logSpy = installConsoleMethodSpy("log");
    const log = createSubsystemLogger("gateway/auth");
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";

    log.info(`provider API_KEY=${secret}`);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const written = firstMockArgAsString(logSpy);
    expect(written).not.toContain(secret);
    expect(written).toContain("API_KEY=***");
    expect(written.endsWith("\u001B[39m")).toBe(true);
  });

  it("redacts sensitive tokens from raw subsystem console output", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const logSpy = installConsoleMethodSpy("log");
    const log = createSubsystemLogger("gateway/auth");
    const secret = "sk-rawtokenabcdefghijklmnopqrstuvwxyz123456";

    log.raw(`raw token ${secret}`);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const written = firstMockArgAsString(logSpy);
    expect(written).not.toContain(secret);
    expect(written).toContain("sk-raw…3456");
  });

  it("keeps long-lived subsystem loggers on the current-day rolling file", () => {
    const logDir = path.dirname(logPathTracker.nextPath());
    const firstDay = path.join(logDir, "openclaw-2026-01-01.log");
    const secondDay = path.join(logDir, "openclaw-2026-01-02.log");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T08:00:00Z"));
    setLoggerOverride({ level: "info", consoleLevel: "silent", file: firstDay });
    const log = createSubsystemLogger("diagnostics");

    log.info("first day subsystem log");
    vi.setSystemTime(new Date("2026-01-02T08:00:00Z"));
    log.info("second day subsystem log");

    expect(fs.readFileSync(firstDay, "utf8")).toContain("first day subsystem log");
    expect(fs.readFileSync(secondDay, "utf8")).toContain("second day subsystem log");
    expect(fs.readFileSync(firstDay, "utf8")).not.toContain("second day subsystem log");
  });

  it("keeps subsystem log semantics diagnostic-only for console and file output", async () => {
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({
      level: "info",
      consoleLevel: "warn",
      consoleStyle: "json",
      file: logPath,
    });
    const warn = installConsoleMethodSpy("warn");
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "log.record") {
        received.push(evt);
      }
    });
    const log = createSubsystemLogger("gateway/auth");

    log.warn("auth refresh failed", {
      logEvent: "auth.refresh",
      logCategory: "gateway.auth",
      logOutcome: "failure",
      logReason: "token_expired",
      provider: "openai",
    });
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      event: "auth.refresh",
      category: "gateway.auth",
      outcome: "failure",
      reason: "token_expired",
      attributes: {
        subsystem: "gateway/auth",
        provider: "openai",
      },
    });
    const consoleLine = firstMockArgAsString(warn);
    const fileContent = fs.readFileSync(logPath, "utf8");
    expect(consoleLine).toContain("auth refresh failed");
    expect(fileContent).toContain("auth refresh failed");
    for (const hidden of ["logEvent", "logCategory", "logOutcome", "logReason", "token_expired"]) {
      expect(consoleLine).not.toContain(hidden);
      expect(fileContent).not.toContain(hidden);
    }
  });

  it("uses the original subsystem caller as diagnostic log source identity", async () => {
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({ level: "warn", consoleLevel: "silent", file: logPath });
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "log.record") {
        received.push(evt);
      }
    });

    emitFirstSubsystemSourceLog();
    emitSecondSubsystemSourceLog();
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(2);
    expect(received[0]?.category).toBe("gateway.heartbeat");
    expect(received[1]?.category).toBe("gateway.heartbeat");
    expect(received[0]?.code?.functionName).toBe("emitFirstSubsystemSourceLog");
    expect(received[1]?.code?.functionName).toBe("emitSecondSubsystemSourceLog");
    expect(received[0]?.code?.functionName).not.toBe("logToFile");
    expect(received[1]?.code?.functionName).not.toBe("logToFile");
    expect(received[0]?.event).toBe("gateway.heartbeat.emitfirstsubsystemsourcelog.warn");
    expect(received[1]?.event).toBe("gateway.heartbeat.emitsecondsubsystemsourcelog.warn");
    expect(received[0]?.code?.siteId).toMatch(/^[0-9a-f]{16}$/u);
    expect(received[1]?.code?.siteId).toMatch(/^[0-9a-f]{16}$/u);
    expect(received[0]?.code?.siteId).not.toBe(received[1]?.code?.siteId);
  });

  it("does not change plain subsystem file output while adding diagnostic source identity", async () => {
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", consoleLevel: "silent", file: logPath });
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "log.record") {
        received.push(evt);
      }
    });
    const log = createSubsystemLogger("gateway/heartbeat");

    log.info("plain subsystem source log");
    await flushDiagnosticEvents();
    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]?.code?.functionName).not.toBe("logToFile");
    const [line] = fs.readFileSync(logPath, "utf8").trim().split("\n");
    const parsed = JSON.parse(line ?? "{}") as Record<string, unknown>;
    expect(parsed["0"]).toBe('{"subsystem":"gateway/heartbeat"}');
    expect(parsed["1"]).toBe("plain subsystem source log");
    expect(parsed["2"]).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("__openclawDiagnostic");
  });
});
