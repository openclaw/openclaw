import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enableConsoleCapture,
  resetLogger,
  routeLogsToStderr,
  setConsoleTimestampPrefix,
  setLoggerOverride,
} from "../logging.js";
import { loggingState } from "./state.js";

type ConsoleSnapshot = {
  log: typeof console.log;
  info: typeof console.info;
  warn: typeof console.warn;
  error: typeof console.error;
  debug: typeof console.debug;
  trace: typeof console.trace;
};

let snapshot: ConsoleSnapshot;

beforeEach(() => {
  snapshot = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    trace: console.trace,
  };
  loggingState.consolePatched = false;
  loggingState.forceConsoleToStderr = false;
  loggingState.consoleTimestampPrefix = false;
  loggingState.rawConsole = null;
  resetLogger();
});

afterEach(() => {
  console.log = snapshot.log;
  console.info = snapshot.info;
  console.warn = snapshot.warn;
  console.error = snapshot.error;
  console.debug = snapshot.debug;
  console.trace = snapshot.trace;
  loggingState.consolePatched = false;
  loggingState.forceConsoleToStderr = false;
  loggingState.consoleTimestampPrefix = false;
  loggingState.rawConsole = null;
  resetLogger();
  setLoggerOverride(null);
  vi.restoreAllMocks();
});

describe("enableConsoleCapture", () => {
  it("swallows EIO from stderr writes", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw eioError();
    });
    routeLogsToStderr();
    enableConsoleCapture();
    expect(() => console.log("hello")).not.toThrow();
  });

  it("swallows EIO from original console writes", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    console.log = () => {
      throw eioError();
    };
    enableConsoleCapture();
    expect(() => console.log("hello")).not.toThrow();
  });

  it("prefixes console output with timestamps when enabled", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    const now = new Date("2026-01-17T18:01:02.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const warn = vi.fn();
    console.warn = warn;
    setConsoleTimestampPrefix(true);
    enableConsoleCapture();
    console.warn("[EventQueue] Slow listener detected");
    expect(warn).toHaveBeenCalledTimes(1);
    const firstArg = String(warn.mock.calls[0]?.[0] ?? "");
    expect(firstArg.startsWith("2026-01-17T18:01:02.000Z [EventQueue]")).toBe(true);
    vi.useRealTimers();
  });

  it("suppresses discord EventQueue slow listener duplicates", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    const warn = vi.fn();
    console.warn = warn;
    enableConsoleCapture();
    console.warn(
      "[EventQueue] Slow listener detected: DiscordMessageListener took 12.3 seconds for event MESSAGE_CREATE",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not double-prefix timestamps", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    const warn = vi.fn();
    console.warn = warn;
    setConsoleTimestampPrefix(true);
    enableConsoleCapture();
    console.warn("12:34:56 [exec] hello");
    expect(warn).toHaveBeenCalledWith("12:34:56 [exec] hello");
  });

  it("leaves JSON output unchanged when timestamp prefix is enabled", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    const log = vi.fn();
    console.log = log;
    setConsoleTimestampPrefix(true);
    enableConsoleCapture();
    const payload = JSON.stringify({ ok: true });
    console.log(payload);
    expect(log).toHaveBeenCalledWith(payload);
  });

  it("truncates large payloads for file log but preserves full stdout output", async () => {
    const logFile = tempLogPath();
    setLoggerOverride({ level: "info", file: logFile });
    const log = vi.fn();
    console.log = log;
    enableConsoleCapture();

    // Create a large payload (like a shell completion script)
    const largePayload = "x".repeat(5000);
    console.log(largePayload);

    // Full payload should still be written to stdout
    expect(log).toHaveBeenCalledWith(largePayload);

    // Give the file logger time to flush (use retries for flaky CI)
    const fs = await import("node:fs/promises");
    let content = "";
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        content = await fs.readFile(logFile, "utf-8");
        if (content.includes("[truncated")) break;
      } catch {
        // File may not exist yet
      }
    }

    // Verify truncation by checking:
    // 1. The truncation marker is present
    expect(content).toContain("[truncated");
    // 2. The full 5000-char payload is NOT in the file (proves it was actually truncated)
    expect(content).not.toContain(largePayload);
    // 3. The file is smaller than the original payload
    expect(content.length).toBeLessThan(largePayload.length);
  });
});

function tempLogPath() {
  return path.join(os.tmpdir(), `openclaw-log-${crypto.randomUUID()}.log`);
}

function eioError() {
  const err = new Error("EIO") as NodeJS.ErrnoException;
  err.code = "EIO";
  return err;
}
