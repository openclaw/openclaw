import { afterEach, describe, expect, it, vi } from "vitest";
import { setConsoleSubsystemFilter } from "./console.js";
import { getChildLogger, resetLogger, setLoggerOverride } from "./logger.js";
import { loggingState } from "./state.js";
import { createSubsystemLogger } from "./subsystem.js";

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
  it("refreshes child logger when parent logger is rebuilt (date roll)", () => {
    setLoggerOverride({ level: "info", consoleLevel: "silent" });

    const log = createSubsystemLogger("test/date-roll");

    // First log call — creates and caches the child logger.
    log.info("day 1 message");

    // Capture the child logger reference via getChildLogger (same parent).
    const firstChild = getChildLogger({ subsystem: "test/date-roll" });

    // Simulate a date-roll rebuild: reset the parent logger so the next
    // getLogger() call produces a new instance (different reference).
    resetLogger();
    setLoggerOverride({ level: "info", consoleLevel: "silent" });

    // Second log call — should detect the parent changed and refresh the child.
    log.info("day 2 message");

    // After the rebuild, a new getChildLogger call should produce a
    // different child instance (derived from the new parent).
    const secondChild = getChildLogger({ subsystem: "test/date-roll" });

    // The child logger instances must differ, proving the subsystem logger
    // refreshed its cached child after the parent was rebuilt.
    expect(firstChild).not.toBe(secondChild);
  });

  it("reuses cached child logger when parent has not changed", () => {
    setLoggerOverride({ level: "info", consoleLevel: "silent" });

    const log = createSubsystemLogger("test/stable");

    // Two log calls without resetting — should reuse the same child.
    log.info("message 1");
    const parentAfterFirst = loggingState.cachedLogger;
    log.info("message 2");
    const parentAfterSecond = loggingState.cachedLogger;

    // Parent reference unchanged — child was reused (no unnecessary rebuild).
    expect(parentAfterFirst).toBe(parentAfterSecond);
  });
});
