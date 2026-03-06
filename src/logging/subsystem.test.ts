import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setConsoleSubsystemFilter } from "./console.js";
import { resetLogger, setLoggerOverride } from "./logger.js";
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

describe("subsystem logger follows root logger rotation (#37388)", () => {
  it("writes to new log file after root logger is rebuilt", () => {
    const tmpDir = path.join(os.tmpdir(), `openclaw-log-rotate-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const file1 = path.join(tmpDir, "openclaw-day1.log");
    const file2 = path.join(tmpDir, "openclaw-day2.log");

    try {
      // Start with file1
      setLoggerOverride({ level: "info", file: file1 });
      const log = createSubsystemLogger("test-subsystem");
      log.info("message-day1");

      // Simulate date change: switch to file2 (setLoggerOverride
      // clears the cached logger and bumps generation, just like
      // resolveSettings would when the date rolls over).
      setLoggerOverride({ level: "info", file: file2 });
      // Write via the same subsystem logger instance
      log.info("message-day2");

      const content1 = fs.existsSync(file1) ? fs.readFileSync(file1, "utf8") : "";
      const content2 = fs.existsSync(file2) ? fs.readFileSync(file2, "utf8") : "";

      expect(content1).toContain("message-day1");
      expect(content1).not.toContain("message-day2");
      expect(content2).toContain("message-day2");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
