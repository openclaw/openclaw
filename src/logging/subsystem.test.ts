// Subsystem logger tests cover per-subsystem log routing and filtering.
import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setVerbose } from "../global-state.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import { mockCall } from "../test-utils/mock-call-assertions.js";
import { setConsoleSubsystemFilter, shouldLogSubsystemToConsole } from "./console.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { applyLoggingConfig, getLogger, resetLogger, setLoggerOverride } from "./logger.js";
import { testApi } from "./logger.test-support.js";
import { getDefaultRedactPatterns } from "./redact.js";
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

beforeAll(async () => {
  await logPathTracker.setup();
});

afterEach(async () => {
  // Settle owned file writes before resetting logging state or removing the suite directory.
  await testApi.flushFileLogQueueForTests();
  setConsoleSubsystemFilter(null);
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
  resetDiagnosticEventsForTest();
  setVerbose(false);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(async () => {
  await logPathTracker.cleanup();
});

describe("createSubsystemLogger().isEnabled", () => {
  it("omits routine call sites while retaining error and fatal locations", async () => {
    const file = logPathTracker.nextPath();
    setLoggerOverride({ level: "trace", consoleLevel: "silent", file });
    const log = createSubsystemLogger("gateway/stack").child("nested");

    for (const level of ["trace", "debug", "info", "warn", "error", "fatal", "raw"] as const) {
      log[level](`stack policy ${level}`);
    }
    await testApi.flushFileLogQueueForTests();

    const records = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.message)).toEqual(
      ["trace", "debug", "info", "warn", "error", "fatal", "raw"].map(
        (level) => `stack policy ${level}`,
      ),
    );
    expect(records.map((record) => Boolean(record._meta.path?.fileLine))).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      false,
    ]);
    for (const record of records) {
      expect(record._meta).toMatchObject({
        name: '{"subsystem":"gateway/stack/nested"}',
        parentNames: ["openclaw"],
      });
    }
  });

  it("tracks diagnostic log interest and enablement for a retained subsystem logger", async () => {
    const file = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", consoleLevel: "silent", file });
    const log = createSubsystemLogger("gateway/stack");
    const listener = vi.fn();

    log.info("no listener");
    const unsubscribeUnrelated = onInternalDiagnosticEvent(listener, { exclude: ["log.record"] });
    log.info("unrelated listener");
    const unsubscribeLogs = onInternalDiagnosticEvent(listener, { include: ["log.record"] });
    log.info("log listener");
    await yieldToEventLoop();
    setDiagnosticsEnabledForProcess(false);
    log.info("disabled diagnostics");
    setDiagnosticsEnabledForProcess(true);
    log.raw("enabled diagnostics");
    await yieldToEventLoop();
    unsubscribeLogs();
    log.info("removed log listener");
    unsubscribeUnrelated();
    await testApi.flushFileLogQueueForTests();

    const records = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => Boolean(record._meta.path?.fileLine))).toEqual([
      false,
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        type: "log.record",
        message: "log listener",
        code: { line: expect.any(Number), functionName: expect.any(String) },
      }),
      expect.objectContaining({
        type: "log.record",
        message: "enabled diagnostics",
        code: { line: expect.any(Number), functionName: expect.any(String) },
      }),
    ]);
  });

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

  it("skips metadata reads, serialization, and transport formatting below both sink levels", () => {
    setLoggerOverride({ level: "info", consoleLevel: "info", consoleStyle: "json" });
    const consoleLog = installConsoleMethodSpy("log");
    const format = vi.fn(() => "formatted");
    const write = vi.fn();
    getLogger().attachTransport({ format, write });
    const serialize = vi.fn(() => "metadata");
    const readField = vi.fn(() => ({ toJSON: serialize }));
    const meta = Object.defineProperty({}, "field", { enumerable: true, get: readField });
    const log = createSubsystemLogger("gateway");

    log.trace("filtered trace", meta);
    log.debug("filtered debug", meta);

    expect(readField).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
    expect(format).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
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

  it.each([undefined, "__proto__"])("emits console output for subsystem label %s", (subsystem) => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger(subsystem as unknown as string);

    log.warn("subsystem diagnostic");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(mockCall(warn)[0])).toContain(`[${subsystem ?? "unknown"}]`);
  });

  it.each([
    ["agent/embedded", true],
    ["model-fallback/decision", true],
    ["  agent/embedded/failover  ", true],
    ["agent/embeddedness", false],
    ["model-fallback-other", false],
    ["Agent/Embedded", false],
  ] as const)("keeps probe policy dynamic for retained %s loggers", (subsystem, suppressed) => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const sink = vi.fn();
    loggingState.rawConsole = { log: sink, info: sink, warn: sink, error: sink };
    const log = createSubsystemLogger(subsystem);

    for (const verbose of [false, true, false]) {
      setVerbose(verbose);
      sink.mockClear();
      log.warn("runId=probe-retained warning");
      log.raw("runId=probe-retained raw");
      expect(sink).toHaveBeenCalledTimes(suppressed && !verbose ? 0 : 2);
    }
  });

  it("keeps setup-inference probe warnings in the file log while suppressing console", async () => {
    const file = logPathTracker.nextPath();
    setLoggerOverride({ level: "warn", consoleLevel: "warn", file });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("agent/embedded");

    log.warn("embedded run failover decision", {
      runId: "probe-setup-inference-test-run",
      provider: "openai",
      consoleMessage: "embedded run failover decision: provider=openai error=Authentication failed",
    });
    log.warn("embedded run agent end", {
      runId: "probe-setup-inference-test-run",
      provider: "openai",
      consoleMessage: "embedded run agent end: provider=openai error=Authentication failed",
    });

    expect(warn).not.toHaveBeenCalled();
    await testApi.flushFileLogQueueForTests();
    const fileLog = fs.readFileSync(file, "utf8");
    expect(fileLog).toContain("embedded run failover decision");
    expect(fileLog).toContain("embedded run agent end");
    expect(fileLog).toContain('"provider":"openai"');
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

  it.each(["current", "current-extra", "custom-only"])(
    "createSubsystemLogger.warn keeps structural protections with %s patterns",
    (variant) => {
      vi.stubEnv("OPENCLAW_TEST_CONSOLE", "1");
      const patterns =
        variant === "custom-only"
          ? []
          : getDefaultRedactPatterns().filter((pattern) => typeof pattern === "string");
      if (variant !== "current") {
        patterns.push("/project-private/g");
      }
      applyLoggingConfig({ level: "silent", consoleLevel: "warn", redactPatterns: patterns });
      const warn = installConsoleMethodSpy("warn");
      const input =
        'body: client_se+cret=opaque-value-123&safe=1\nAuthorization: Digest username="alice", realm="example", response="digest-response-1234567890abcdef"; status=401';

      const secret = "Ab9Q".repeat(10);
      createSubsystemLogger("gateway").warn(
        `${input}\n${secret} s3://user:${secret}@bucket project-private`,
      );

      expect(String(mockCall(warn)[0])).not.toContain(secret);
      expect(String(mockCall(warn)[0])).toContain("s3://user:Ab9QAb…Ab9Q@bucket");
      if (variant !== "current") {
        expect(String(mockCall(warn)[0])).not.toContain("project-private");
      }
      expect(String(mockCall(warn)[0])).toContain("body: client_se+cret=***&safe=1");
      expect(String(mockCall(warn)[0])).toContain("Authorization: Digest ***; status=401");
    },
  );

  it("createSubsystemLogger.warn masks slash-containing database passwords with default patterns", () => {
    vi.stubEnv("OPENCLAW_TEST_CONSOLE", "1");
    applyLoggingConfig({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    createSubsystemLogger("gateway").warn(
      `postgres://user:${"a".repeat(40)}/b@db.example.test/app`,
    );
    expect(String(mockCall(warn)[0])).toContain("postgres://user:aaaaaa…aa/b@db.example.test/app");
  });

  it("getLogger.info preserves every public URL in the final file message", async () => {
    const url = "https://x.com/EliXPampa/status/2097727549400871286";
    const inputs = [
      `https://example.test/${"Ab9Q".repeat(10)}@latest`,
      `https://example.test/path,${"Ab9Q".repeat(10)}`,
      `s3://user:1234/${"Ab9Q".repeat(8)}Ab9`,
      `payload ${JSON.stringify([url, url])}`,
      `payload ${JSON.stringify({ a: url, b: url })}`,
      `payload ${JSON.stringify([`${url}?safe=1`, url])}`,
      `payload ${JSON.stringify(JSON.stringify([`${url}?safe=1`, url]))}`,
    ];
    const file = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", consoleLevel: "silent", file });
    for (const input of inputs) {
      getLogger().info(input);
    }
    await testApi.flushFileLogQueueForTests();

    const messages = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { message: string }).message);
    expect(messages).toEqual(inputs);
  });

  it.each(["part/", "/", "1234/"])(
    "getLogger.info retains malformed credential masking after %s",
    async (prefix) => {
      const secret = prefix === "1234/" ? `${"Ab9Q".repeat(8)}Ab9` : "Ab9Q".repeat(10);
      const file = logPathTracker.nextPath();
      setLoggerOverride({ level: "info", consoleLevel: "silent", file });
      getLogger().info(`s3://user:${prefix}${secret}@bucket`);
      await testApi.flushFileLogQueueForTests();

      const written = fs.readFileSync(file, "utf8");
      expect(written).not.toContain(secret);
      expect(written).toContain("@bucket");
    },
  );

  it("redacts sensitive tokens at the console sink so subsystem writes do not leak secrets (#73284)", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("gateway");
    const secret = "sk-supersecretvaluefortest12345";

    log.warn(`token=${secret}`);

    expect(warn).toHaveBeenCalledTimes(1);
    const written = String(mockCall(warn)[0]);
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
    const written = String(mockCall(error)[0]);
    expect(written).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(written).toContain("Bearer ");
  });

  it.each(["pretty", "compact"] as const)(
    "preserves redaction and ANSI resets as color settings change in %s style",
    (consoleStyle) => {
      vi.stubEnv("NO_COLOR", "1");
      setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle });
      const logSpy = installConsoleMethodSpy("log");
      const log = createSubsystemLogger("gateway/auth");
      const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";

      for (const forceColor of ["1", "0", "1"]) {
        vi.stubEnv("FORCE_COLOR", forceColor);
        logSpy.mockClear();
        log.info(`provider API_KEY=${secret}`);

        expect(logSpy).toHaveBeenCalledTimes(1);
        const written = String(mockCall(logSpy)[0]);
        expect(written).not.toContain(secret);
        expect(written).toContain("API_KEY=***");
        expect(written).toContain("[auth]");
        expect(written.endsWith("\u001B[39m")).toBe(forceColor === "1");
      }
    },
  );

  it("redacts sensitive tokens from raw subsystem console output", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const logSpy = installConsoleMethodSpy("log");
    const log = createSubsystemLogger("gateway/auth");
    const secret = "sk-rawtokenabcdefghijklmnopqrstuvwxyz123456";

    log.raw(`raw token ${secret}`);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const written = String(mockCall(logSpy)[0]);
    expect(written).not.toContain(secret);
    expect(written).toContain("sk-raw…3456");
  });

  it("wraps raw subsystem output when console style is JSON", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "json" });
    const logSpy = installConsoleMethodSpy("log");

    createSubsystemLogger("gateway/auth").raw("raw diagnostic");

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(mockCall(logSpy)[0]))).toMatchObject({
      level: "info",
      subsystem: "gateway/auth",
      message: "raw diagnostic",
    });
  });

  it.each(["pretty", "compact"] as const)(
    "keeps raw subsystem output unchanged in %s style",
    (consoleStyle) => {
      setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle });
      const logSpy = installConsoleMethodSpy("log");

      createSubsystemLogger("gateway/auth").raw("raw diagnostic");

      expect(logSpy).toHaveBeenCalledWith("raw diagnostic");
    },
  );

  it("appends warn/error structured fields as compact key=value pairs in plain console styles", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "pretty" });
    const warn = vi.fn();
    const error = vi.fn();
    loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error };
    const log = createSubsystemLogger("session-catalog");

    log.warn("slow Codex catalog list phases", {
      elapsedMs: 12345,
      admissionWaitMs: 0,
      admitted: true,
      phaseDurationsMs: { open: 3, validation: 8 },
      note: "two words",
      skipped: undefined,
      error: new Error("boom"),
    });
    log.error("catalog failed", { reason: "timeout" });

    expect(warn).toHaveBeenCalledTimes(1);
    const warnLine = String(mockCall(warn)[0]);
    expect(warnLine).toContain("slow Codex catalog list phases");
    expect(warnLine).toContain(
      'elapsedMs=12345 admissionWaitMs=0 admitted=true phaseDurationsMs={"open":3,"validation":8} note="two words" error=boom',
    );
    expect(warnLine).not.toContain("skipped=");
    expect(String(mockCall(error)[0])).toContain("catalog failed reason=timeout");
  });

  it("masks key-aware sensitive fields in the console tail", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "pretty" });
    const warn = vi.fn();
    loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };

    createSubsystemLogger("gateway").warn("provider retry", {
      apiToken: "opaque-value-no-pattern-match",
      nested: { password: "hunter2" },
      elapsedMs: 12,
    });

    const warnLine = String(mockCall(warn)[0]);
    expect(warnLine).not.toContain("opaque-value-no-pattern-match");
    expect(warnLine).not.toContain("hunter2");
    expect(warnLine).toContain("elapsedMs=12");
  });

  it("redacts structured fields before the console tail length cap clips them", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "pretty" });
    const warn = vi.fn();
    loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };

    createSubsystemLogger("gateway").warn("provider retry", {
      // Sized so an unredacted tail would be cut in the middle of the value below.
      padding: "x".repeat(2040),
      apiToken: "opaque-value-no-pattern-match",
    });

    const warnLine = String(mockCall(warn)[0]);
    expect(warnLine).not.toContain("opaque-value");
    expect(warnLine).toContain("...(truncated)");
  });

  it("leaves json console output untouched and serializes each field once", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
    const warn = vi.fn();
    loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    let serializations = 0;
    const stateful = {
      toJSON() {
        serializations += 1;
        return { calls: serializations };
      },
    };

    createSubsystemLogger("gateway").warn("provider retry", { elapsedMs: 12, stateful });

    const parsed = JSON.parse(String(mockCall(warn)[0]));
    expect(parsed).toMatchObject({ level: "warn", message: "provider retry", elapsedMs: 12 });
    expect(serializations).toBe(1);
  });

  it("keeps a circular field readable on one line and omits fields with no JSON form", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "pretty" });
    const warn = vi.fn();
    loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const circular: Record<string, unknown> = { name: "catalog" };
    circular.self = circular;

    createSubsystemLogger("session-catalog").warn("slow list", {
      circular,
      big: 10n,
      // Dropped by the shared redactor, matching the file sink and the json style.
      handler: () => undefined,
    });

    const warnLine = String(mockCall(warn)[0]);
    expect(warnLine).toContain('circular={"name":"catalog","self":"[Circular]"}');
    expect(warnLine).toContain("big=10");
    expect(warnLine).not.toContain("handler=");
    expect(warnLine).not.toContain("\n");
  });

  it("keeps info console lines and explicit consoleMessage overrides free of structured fields", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const logSpy = vi.fn();
    const warn = vi.fn();
    loggingState.rawConsole = { log: logSpy, info: vi.fn(), warn, error: vi.fn() };
    const log = createSubsystemLogger("gateway");

    log.info("listing sessions", { elapsedMs: 5 });
    log.warn("slow list", { elapsedMs: 5000, consoleMessage: "slow list (see file log)" });

    expect(String(mockCall(logSpy)[0])).not.toContain("elapsedMs=");
    const warnLine = String(mockCall(warn)[0]);
    expect(warnLine).toContain("slow list (see file log)");
    expect(warnLine).not.toContain("elapsedMs=");
  });

  it("preserves structured subsystem fields through the shared JSON formatter", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
    const warn = installConsoleMethodSpy("warn");

    createSubsystemLogger("gateway/auth").warn("authentication retry", { attempt: 2 });

    expect(JSON.parse(String(mockCall(warn)[0]))).toMatchObject({
      level: "warn",
      subsystem: "gateway/auth",
      message: "authentication retry",
      attempt: 2,
    });
  });

  it("keeps long-lived subsystem loggers on the current-day rolling file", async () => {
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
    await testApi.flushFileLogQueueForTests();

    expect(fs.readFileSync(firstDay, "utf8")).toContain("first day subsystem log");
    expect(fs.readFileSync(secondDay, "utf8")).toContain("second day subsystem log");
    expect(fs.readFileSync(firstDay, "utf8")).not.toContain("second day subsystem log");
  });

  it("keeps a retained logger on the new file after reset", async () => {
    const firstFile = logPathTracker.nextPath();
    const secondFile = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", consoleLevel: "silent", file: firstFile });
    const log = createSubsystemLogger("diagnostics");

    log.info("first line");
    log.info("second line");

    resetLogger();
    setLoggerOverride({ level: "info", consoleLevel: "silent", file: secondFile });
    log.info("after reset");
    await testApi.flushFileLogQueueForTests();
    expect(fs.readFileSync(firstFile, "utf8")).toContain("first line");
    expect(fs.readFileSync(firstFile, "utf8")).not.toContain("after reset");
    expect(fs.readFileSync(secondFile, "utf8")).toContain("after reset");
  });

  it("applies the new file and level to a retained logger", async () => {
    const firstFile = logPathTracker.nextPath();
    const secondFile = logPathTracker.nextPath();
    vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
    applyLoggingConfig({ level: "info", consoleLevel: "silent", file: firstFile });
    const log = createSubsystemLogger("diagnostics");

    log.info("first line");
    log.info("second line");
    expect(log.isEnabled("debug", "file")).toBe(false);

    applyLoggingConfig({ level: "debug", consoleLevel: "silent", file: secondFile });
    expect(log.isEnabled("debug", "file")).toBe(true);
    log.debug("after applied config");
    await testApi.flushFileLogQueueForTests();
    expect(fs.readFileSync(firstFile, "utf8")).toContain("first line");
    expect(fs.readFileSync(firstFile, "utf8")).not.toContain("after applied config");
    expect(fs.readFileSync(secondFile, "utf8")).toContain("after applied config");
  });
});
