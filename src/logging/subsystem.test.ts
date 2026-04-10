import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setConsoleSubsystemFilter } from "./console.js";
import { getChildLogger, resetLogger, setLoggerOverride } from "./logger.js";
import { loggingState } from "./state.js";
import { createSubsystemLogger } from "./subsystem.js";

// Spy on getChildLogger so the date-roll regression suite can directly assert
// that the closure inside createSubsystemLogger refreshes its cached child
// logger by re-invoking getChildLogger after the parent logger is rebuilt.
vi.mock("./logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./logger.js")>();
  return {
    ...actual,
    getChildLogger: vi.fn(actual.getChildLogger),
  };
});

function installConsoleMethodSpy(method: "warn" | "error") {
  const spy = vi.fn();
  loggingState.rawConsole = {
    log: vi.fn(),
    info: vi.fn(),
    warn: method === "warn" ? spy : vi.fn(),
    error: method === "error" ? spy : vi.fn(),
  };
  return spy;
}

afterEach(() => {
  setConsoleSubsystemFilter(null);
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
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
});

describe("createSubsystemLogger file logger staleness (#62381)", () => {
  const getChildLoggerMock = vi.mocked(getChildLogger);

  beforeEach(() => {
    getChildLoggerMock.mockClear();
  });

  it("refreshes child logger when parent logger is rebuilt (date roll)", () => {
    setLoggerOverride({ level: "info", consoleLevel: "silent" });

    const log = createSubsystemLogger("test/date-roll");

    // First log call — populates the closure-cached file logger by invoking
    // getChildLogger exactly once.
    log.info("day 1 message");
    expect(getChildLoggerMock).toHaveBeenCalledTimes(1);

    getChildLoggerMock.mockClear();

    // Simulate a date-roll rebuild: reset the parent logger so the next
    // getLogger() call produces a brand-new instance and the closure's
    // cachedParentRef no longer matches loggingState.cachedLogger.
    resetLogger();
    setLoggerOverride({ level: "info", consoleLevel: "silent" });

    // Second log call — the closure must detect the parent change and
    // refresh the cached child by calling getChildLogger again. This is
    // the exact regression covered by the bug fix in #62381.
    log.info("day 2 message");
    expect(getChildLoggerMock).toHaveBeenCalledTimes(1);
  });

  it("reuses cached child logger when parent has not changed", () => {
    setLoggerOverride({ level: "info", consoleLevel: "silent" });

    const log = createSubsystemLogger("test/stable");

    // Two log calls without resetting the parent — the closure should
    // call getChildLogger exactly once and reuse the cached child for
    // subsequent log calls (no unnecessary sublogger rebuilds).
    log.info("message 1");
    log.info("message 2");

    expect(getChildLoggerMock).toHaveBeenCalledTimes(1);
  });
});
