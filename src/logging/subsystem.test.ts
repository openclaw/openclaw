import fs from "node:fs";
import util from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setVerbose } from "../global-state.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import { mockCall } from "../test-utils/mock-call-assertions.js";
import { expectText } from "../test-utils/text-assertions.js";
import { logCodeModeFailure } from "./code-mode-diagnostic.js";
import { setConsoleSubsystemFilter, shouldLogSubsystemToConsole } from "./console.js";
import { readConfiguredLogTail } from "./log-tail.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { applyLoggingConfig, getLogger, resetLogger, setLoggerOverride } from "./logger.js";
import { testApi } from "./logger.test-support.js";
import { getDefaultRedactPatterns } from "./redact.js";
import { loggingState } from "./state.js";
import { createSubsystemLogger, runtimeForLogger } from "./subsystem.js";

const logPathTracker = createSuiteLogPathTracker("openclaw-subsystem-log-");

function fileLogging(level: "info" | "warn" | "error" | "trace") {
  const file = logPathTracker.nextPath();
  setLoggerOverride({ level, consoleLevel: "silent", file });
  return file;
}

async function readRecords(file: string) {
  await testApi.flushFileLogQueueForTests();
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function consoleLogging(
  consoleStyle: "pretty" | "json" | "compact" = "pretty",
  consoleLevel: "warn" | "info" | "error" = "warn",
) {
  setLoggerOverride({ level: "silent", consoleLevel, consoleStyle });
  return installConsoleMethodSpy(consoleLevel === "info" ? "log" : consoleLevel);
}

const consoleLine = (spy: ReturnType<typeof installConsoleMethodSpy>) => String(mockCall(spy)[0]);

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

beforeAll(() => logPathTracker.setup());

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

afterAll(() => logPathTracker.cleanup());

it("formats host runtime arguments before routing them to the subsystem logger", () => {
  setLoggerOverride({ level: "silent", consoleLevel: "info" });
  const logger = createSubsystemLogger("runtime-arguments");
  const info = vi.spyOn(logger, "info").mockImplementation(() => {});
  const error = vi.spyOn(logger, "error").mockImplementation(() => {});
  const runtime = runtimeForLogger(logger);
  runtime.log("ready", { active: true }, 17);
  runtime.error("failed", { retryable: false });
  expect(info).toHaveBeenCalledExactlyOnceWith("ready { active: true } 17");
  expect(error).toHaveBeenCalledExactlyOnceWith("failed { retryable: false }");
});

it("does not inspect or serialize disabled runtime output as sink levels change", () => {
  const inspect = vi.fn(() => "fixture inspected");
  const toJSON = vi.fn(() => ({ fixture: true }));
  const value = { [util.inspect.custom]: inspect, toJSON };
  const runtime = runtimeForLogger(createSubsystemLogger("runtime-levels"));
  const sink = vi.fn();
  loggingState.rawConsole = { log: sink, info: sink, warn: sink, error: sink };

  for (const consoleLevel of ["silent", "info", "silent"] as const) {
    setLoggerOverride({ level: "silent", consoleLevel });
    inspect.mockClear();
    toJSON.mockClear();
    sink.mockClear();
    runtime.log("ready", value);
    runtime.error("failed", value);
    runtime.writeJson(value);
    expect(inspect).toHaveBeenCalledTimes(consoleLevel === "info" ? 2 : 0);
    expect(toJSON).toHaveBeenCalledTimes(consoleLevel === "info" ? 1 : 0);
    expect(sink).toHaveBeenCalledTimes(consoleLevel === "info" ? 3 : 0);
  }
});

it.each(["pretty", "compact", "json"] as const)(
  "keeps explicitly file-only diagnostics out of the %s console",
  async (consoleStyle) => {
    const file = logPathTracker.nextPath();
    setLoggerOverride({ level: "debug", consoleLevel: "debug", consoleStyle, file });
    const consoleLog = installConsoleMethodSpy("log");
    const log = createSubsystemLogger("diagnostic");

    log.info("phase observation", { consoleMessage: false, phase: "selected" });
    log.debug("timing observation", { consoleMessage: false, elapsedMs: 12 });

    expect(consoleLog).not.toHaveBeenCalled();
    const records = await readRecords(file);
    expect(records.map((record) => record.message)).toEqual([
      "phase observation",
      "timing observation",
    ]);
    expect(records.map((record) => record["1"])).toEqual([
      { phase: "selected" },
      { elapsedMs: 12 },
    ]);
    log.debug("readable diagnostic remains visible");
    expect(consoleLog).toHaveBeenCalledOnce();
  },
);

describe("createSubsystemLogger().isEnabled", () => {
  it.each([
    ["guest", undefined, "WARN"],
    ["input", undefined, "WARN"],
    ["bridge", "invalid_input", "WARN"],
    ["bridge", "input_contract", "WARN"],
    ["bridge", "tool_error", "ERROR"],
    ["bridge", "output_contract", "ERROR"],
    ["host", "runtime_unavailable", "ERROR"],
  ] as const)("logs %s/%s failures at %s", async (failurePhase, failureCode, level) => {
    const file = fileLogging("warn");
    logCodeModeFailure(new Error("synthetic failure"), { failurePhase, failureCode });
    const records = await readRecords(file);
    expect(records).toHaveLength(1);
    expect(records[0]._meta.logLevelName).toBe(level);
  });
  it("records content-free Code Mode failure categories and correlation ids without a debug flag", async () => {
    const file = fileLogging("error");
    vi.stubEnv("OPENCLAW_DEBUG_CODE_MODE", "0");
    const marker = "synthetic-private-code-mode-content";
    const privateFields = {
      name: `${marker}-name`,
      code: `${marker}-code`,
      stack: `${marker}-stack`,
    };
    const failures = [
      {
        error: Object.assign(new TypeError(`${marker} timed out`), privateFields),
        expected: { errorCategory: "TypeError", failureKind: "timeout" },
      },
      {
        error: new Error(marker, {
          cause: Object.assign(new RangeError(`${marker} connection reset`), privateFields),
        }),
        expected: { errorCategory: "RangeError", failureKind: "connection_reset" },
      },
      {
        error: { ...privateFields, message: `${marker} aborted` },
        expected: { errorCategory: "object", failureKind: "aborted" },
      },
      {
        error: new Error(marker, {
          cause: Object.assign(new Error(marker), privateFields, {
            code: "ERR_WORKER_OUT_OF_MEMORY",
          }),
        }),
        expected: { errorCategory: "Error", errorCode: "ERR_WORKER_OUT_OF_MEMORY" },
      },
    ];
    const context = {
      failurePhase: "bridge",
      sessionId: "session-fixture",
      sessionKey: "agent:fixture:main",
      runId: "agent-run-fixture",
      codeModeRunId: "cell-fixture",
      toolCallId: "call-fixture",
      workerId: "worker-fixture",
      bridgeRequestId: "bridge:callValue:1",
      bridgeDispatchStarted: true,
    };
    for (const { error } of failures) {
      logCodeModeFailure(error, context);
    }
    const records = await readRecords(file);
    expect(fs.readFileSync(file, "utf8")).not.toContain(marker);
    expect(records.map((record) => record["1"])).toEqual(
      failures.map(({ expected }) => Object.assign({}, context, expected)),
    );
  });
  it.each([
    ["discord gateway: closed", "[discord] gateway: closed"],
    ["[discord] connection stalled", "[discord] connection stalled"],
  ])("emits one subsystem label for %s", (input, expected) => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("FORCE_COLOR", "0");
    const log = consoleLogging("compact", "info");
    createSubsystemLogger("discord").info(input);
    expect(log).toHaveBeenCalledExactlyOnceWith(expected);
  });
  it("omits routine call sites while retaining error and fatal locations", async () => {
    const file = fileLogging("trace");
    const log = createSubsystemLogger("gateway/stack").child("nested");
    const levels = ["trace", "debug", "info", "warn", "error", "fatal", "raw"] as const;
    for (const level of levels) {
      log[level](`stack policy ${level}`);
    }
    const records = await readRecords(file);
    expect(records.map((record) => record.message)).toEqual(
      levels.map((level) => `stack policy ${level}`),
    );
    expect(records.map((record) => Boolean(record._meta.path?.fileLine))).toEqual(
      levels.map((level) => level === "error" || level === "fatal"),
    );
    for (const record of records) {
      expect(record._meta).toMatchObject({
        name: '{"subsystem":"gateway/stack/nested"}',
        parentNames: ["openclaw"],
      });
    }
  });
  it("exports INFO diagnostics without call sites while retaining warning locations", async () => {
    const file = fileLogging("info");
    const log = createSubsystemLogger("gateway/stack");
    const listener = vi.fn();
    log.info("no listener");
    const unsubscribeUnrelated = onInternalDiagnosticEvent(listener, { exclude: ["log.record"] });
    log.info("unrelated listener");
    const unsubscribeLogs = onInternalDiagnosticEvent(listener, { include: ["log.record"] });
    log.info("log listener");
    log.warn("warning with listener");
    await waitForDiagnosticEventsDrained();
    setDiagnosticsEnabledForProcess(false);
    log.info("disabled diagnostics");
    setDiagnosticsEnabledForProcess(true);
    log.raw("enabled diagnostics");
    await waitForDiagnosticEventsDrained();
    unsubscribeLogs();
    log.info("removed log listener");
    unsubscribeUnrelated();
    const records = await readRecords(file);
    expect(records.map((record) => Boolean(record._meta.path?.fileLine))).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        type: "log.record",
        message: "log listener",
      }),
      expect.objectContaining({
        type: "log.record",
        message: "warning with listener",
        code: { line: expect.any(Number), functionName: expect.any(String) },
      }),
      expect.objectContaining({
        type: "log.record",
        message: "enabled diagnostics",
      }),
    ]);
    for (const [event] of listener.mock.calls) {
      if (event.level === "INFO") {
        expect(event).not.toHaveProperty("code");
      }
    }
  });
  it("resolves sink enablement from thresholds and console-only subsystem filters", () => {
    for (const [level, consoleLevel, query, filtered, malformed, file, console] of [
      ["debug", "silent", "debug", false, false, true, false],
      ["silent", "debug", "debug", false, false, false, true],
      ["silent", "fatal", "error", false, false, false, false],
      ["silent", "fatal", "fatal", false, false, false, true],
      ["silent", "trace", "debug", false, false, false, true],
      ["silent", "info", "silent", false, false, false, false],
      ["silent", "silent", "debug", false, false, false, false],
      ["silent", "info", "info", true, false, false, false],
      ["info", "silent", "info", true, false, true, false],
      ["silent", "info", "info", true, true, false, false],
    ] as const) {
      setLoggerOverride({ level, consoleLevel });
      setConsoleSubsystemFilter(filtered ? ["gateway"] : null);
      const log = createSubsystemLogger(
        malformed ? (undefined as unknown as string) : "agent/embedded",
      );
      expect([
        log.isEnabled(query),
        log.isEnabled(query, "file"),
        log.isEnabled(query, "console"),
      ]).toEqual([file || console, file, console]);
      if (malformed) {
        expect(shouldLogSubsystemToConsole(undefined)).toBe(false);
      }
    }
  });
  it("keeps probe policy dynamic for retained model-fallback loggers", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const sink = vi.fn();
    loggingState.rawConsole = { log: sink, info: sink, warn: sink, error: sink };
    const log = createSubsystemLogger("model-fallback/decision");
    for (const verbose of [false, true, false]) {
      setVerbose(verbose);
      sink.mockClear();
      log.warn("runId=probe-retained warning");
      log.raw("runId=probe-retained raw");
      expect(sink).toHaveBeenCalledTimes(verbose ? 2 : 0);
    }
  });
  it("keeps setup-inference probe warnings in the file log while suppressing console", async () => {
    const file = logPathTracker.nextPath();
    setLoggerOverride({ level: "warn", consoleLevel: "warn", file });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("agent/embedded");
    const messages = ["embedded run failover decision", "embedded run agent end"];
    for (const message of messages) {
      log.warn(message, {
        runId: "probe-setup-inference-test-run",
        provider: "openai",
        consoleMessage: `${message}: provider=openai error=Authentication failed`,
      });
    }
    expect(warn).not.toHaveBeenCalled();
    await testApi.flushFileLogQueueForTests();
    const fileLog = fs.readFileSync(file, "utf8");
    expectText(fileLog, [...messages, '"provider":"openai"']);
  });
  it.each(["part/", "1234/"])(
    "log tail masks raw malformed credentials after %s",
    async (prefix) => {
      const secret = prefix === "1234/" ? `${"Ab9Q".repeat(8)}Ab9` : "Ab9Q".repeat(10);
      const file = fileLogging("info");
      getLogger().info(`s3://user:${prefix}${secret}@bucket`);
      await testApi.flushFileLogQueueForTests();
      const written = fs.readFileSync(file, "utf8");
      expect(written).toContain(secret);
      const tail = await readConfiguredLogTail();
      expect(tail.lines).toHaveLength(1);
      expect(tail.lines[0]).not.toContain(secret);
      expect(tail.lines[0]).toContain("@bucket");
    },
  );
  it("redacts tokens at the subsystem error console sink (#73284)", () => {
    const secret = "abcdefghijklmnopqrstuvwxyz";
    vi.stubEnv("OPENCLAW_TEST_CONSOLE", "1");
    applyLoggingConfig({
      level: "silent",
      consoleLevel: "error",
      redactPatterns: [
        ...getDefaultRedactPatterns().filter((pattern) => typeof pattern === "string"),
        "/project-private/g",
      ],
    });
    const sink = installConsoleMethodSpy("error");
    createSubsystemLogger("gateway")
      .child("auth")
      .error(`Authorization failed: Bearer ${secret} project-private`);
    expect(sink).toHaveBeenCalledTimes(1);
    expectText(consoleLine(sink), ["Bearer "], [secret, "project-private"]);
  });
  it("preserves redaction and ANSI resets as color settings change in pretty style", () => {
    vi.stubEnv("NO_COLOR", "1");
    const logSpy = consoleLogging("pretty", "info");
    const log = createSubsystemLogger("gateway/auth");
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    for (const forceColor of ["1", "0", "1"]) {
      vi.stubEnv("FORCE_COLOR", forceColor);
      logSpy.mockClear();
      log.info(`provider API_KEY=${secret}`);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const written = consoleLine(logSpy);
      expectText(written, ["API_KEY=***", "[auth]"], [secret]);
      expect(written.endsWith("\u001B[39m")).toBe(forceColor === "1");
    }
  });
  it.each(["redacted", "json"] as const)(
    "preserves raw subsystem output through the %s console route",
    (variant) => {
      setLoggerOverride({
        level: "silent",
        consoleLevel: "info",
        consoleStyle: variant === "redacted" ? undefined : variant,
      });
      const logSpy = installConsoleMethodSpy("log");
      const secret = "sk-rawtokenabcdefghijklmnopqrstuvwxyz123456";
      const message = variant === "redacted" ? `raw token ${secret}` : "raw diagnostic";
      createSubsystemLogger("gateway/auth").raw(message);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const written = consoleLine(logSpy);
      if (variant === "json") {
        expect(JSON.parse(written)).toMatchObject({
          level: "info",
          subsystem: "gateway/auth",
          message,
        });
      } else {
        expect(written).not.toContain(secret);
        expect(written).toContain("sk-raw…3456");
      }
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
    const warnLine = consoleLine(warn);
    expect(warnLine).toContain("slow Codex catalog list phases");
    expect(warnLine).toContain(
      'elapsedMs=12345 admissionWaitMs=0 admitted=true phaseDurationsMs={"open":3,"validation":8} note="two words" error={"name":"Error","message":"boom"',
    );
    expect(warnLine).not.toContain("skipped=");
    expect(consoleLine(error)).toContain("catalog failed reason=timeout");
  });
  it("retains lifecycle error diagnostics in the file and pretty console sinks", async () => {
    const file = logPathTracker.nextPath();
    setLoggerOverride({ level: "warn", consoleLevel: "warn", consoleStyle: "pretty", file });
    const warn = installConsoleMethodSpy("warn");
    const failure = Object.assign(new Error("Pending input ownership ended"), {
      name: "SessionPendingInputCustodyError",
      code: "CUSTODY_ENDED",
      syscall: "synthetic-settle",
      requestId: "synthetic-request",
      request: { body: "synthetic private completion" },
      config: { data: "synthetic private tool input" },
      stack:
        "Error: Pending input ownership ended\n    at settle (fixture.ts:1:1)\n    at wake (fixture.ts:2:1)\n    at complete (fixture.ts:3:1)\n    at parent (fixture.ts:4:1)\n    at lifecycle (fixture.ts:5:1)\n    at omitted (fixture.ts:6:1)",
    });
    const expectedError = {
      name: "SessionPendingInputCustodyError",
      message: "Pending input ownership ended",
      errorCode: "CUSTODY_ENDED",
      stack: failure.stack.split("\n").slice(0, 6).join("\n"),
    };
    createSubsystemLogger("agents/subagent-registry").warn("lifecycle event handler failed", {
      err: failure,
      runId: "synthetic-child",
    });
    await testApi.flushFileLogQueueForTests();
    const record = JSON.parse(fs.readFileSync(file, "utf8").trim());
    expect(record["1"]).toEqual({
      err: { ...expectedError, stack: failure.stack },
      runId: "synthetic-child",
    });
    const line = consoleLine(warn);
    const errorStart = line.indexOf("err=") + "err=".length;
    expect(JSON.parse(line.slice(errorStart, line.lastIndexOf(" runId=")))).toEqual(expectedError);
    expectText(line, ["runId=synthetic-child"], ["omitted", "synthetic private"]);
    expect(fs.readFileSync(file, "utf8")).not.toContain("synthetic private");
    expect(failure.stack).toContain("omitted");
  });
  it("masks key-aware sensitive fields in the console tail", () => {
    const warn = consoleLogging();
    createSubsystemLogger("gateway").warn("provider retry", {
      apiToken: "opaque-value-no-pattern-match",
      nested: { password: "hunter2" },
      elapsedMs: 12,
    });
    expectText(consoleLine(warn), ["elapsedMs=12"], ["opaque-value-no-pattern-match", "hunter2"]);
  });
  it("redacts structured fields before the console tail length cap clips them", () => {
    const warn = consoleLogging();
    createSubsystemLogger("gateway").warn("provider retry", {
      // Sized so an unredacted tail would be cut in the middle of the value below.
      padding: "x".repeat(2040),
      apiToken: "opaque-value-no-pattern-match",
    });
    expectText(consoleLine(warn), ["...(truncated)"], ["opaque-value"]);
  });
  it("leaves json console output untouched and serializes each field once", () => {
    const warn = consoleLogging("json");
    let serializations = 0;
    const stateful = {
      toJSON() {
        serializations += 1;
        return { calls: serializations };
      },
    };
    createSubsystemLogger("gateway/auth").warn("provider retry", {
      elapsedMs: 12,
      attempt: 2,
      stateful,
    });
    const parsed = JSON.parse(consoleLine(warn));
    expect(parsed).toMatchObject({
      level: "warn",
      subsystem: "gateway/auth",
      message: "provider retry",
      elapsedMs: 12,
      attempt: 2,
    });
    expect(serializations).toBe(1);
  });
  it("keeps a circular field readable on one line and omits fields with no JSON form", () => {
    const warn = consoleLogging();
    const circular: Record<string, unknown> = { name: "catalog" };
    circular.self = circular;
    createSubsystemLogger("session-catalog").warn("slow list", {
      circular,
      big: 10n,
      // Dropped by the shared redactor, matching the file sink and the json style.
      handler: () => undefined,
    });
    expectText(
      consoleLine(warn),
      ['circular={"name":"catalog","self":"[Circular]"}', "big=10"],
      ["handler=", "\n"],
    );
  });
});
