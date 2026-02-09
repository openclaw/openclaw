import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enableConsoleCapture,
  resetLogger,
  routeLogsToStderr,
  setLoggerOverride,
} from "../logging.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

describe("completion stdout cleanliness", () => {
  let originalLog: typeof console.log;
  let originalInfo: typeof console.info;
  let originalWarn: typeof console.warn;
  let originalError: typeof console.error;
  let originalDebug: typeof console.debug;
  let originalTrace: typeof console.trace;

  beforeEach(() => {
    originalLog = console.log;
    originalInfo = console.info;
    originalWarn = console.warn;
    originalError = console.error;
    originalDebug = console.debug;
    originalTrace = console.trace;
    loggingState.consolePatched = false;
    loggingState.forceConsoleToStderr = false;
    loggingState.rawConsole = null;
    resetLogger();
  });

  afterEach(() => {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
    console.debug = originalDebug;
    console.trace = originalTrace;
    loggingState.consolePatched = false;
    loggingState.forceConsoleToStderr = false;
    loggingState.rawConsole = null;
    resetLogger();
    vi.restoreAllMocks();
  });

  it("subsystem logger does not write to stdout when routeLogsToStderr is active", () => {
    // Spy on the actual stdout stream to verify no log leakage.
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    setLoggerOverride({ level: "info", file: "/dev/null" });
    enableConsoleCapture();
    routeLogsToStderr();

    // After capture, spy on rawConsole.error — the stderr-bound sink used by writeConsoleLine().
    // writeConsoleLine routes to rawConsole.error (not process.stderr.write) when forceConsoleToStderr is set.
    const rawErrorSpy = vi.spyOn(loggingState.rawConsole!, "error");

    // Simulate what happens during plugin loading — a subsystem logger emitting to console
    const logger = createSubsystemLogger("plugins");
    logger.info("Loaded 3 plugins");

    // stdout should NOT have received the subsystem log message
    const stdoutOutput = stdoutWrite.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(stdoutOutput).not.toContain("plugins");
    // rawConsole.error (the stderr sink) should have received it
    expect(rawErrorSpy).toHaveBeenCalled();
    const errorOutput = String(rawErrorSpy.mock.calls[0]?.[0] ?? "");
    expect(errorOutput).toContain("plugins");
  });

  it("process.stdout.write bypasses patched console when forceConsoleToStderr is active", () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    setLoggerOverride({ level: "info", file: "/dev/null" });
    enableConsoleCapture();
    routeLogsToStderr();

    // After the fix, completion will write its script directly to stdout via process.stdout.write.
    // This bypasses the patched console.log which would redirect to stderr.
    const script = "#compdef openclaw\n_openclaw() { ... }\ncompdef _openclaw openclaw\n";
    process.stdout.write(script);

    // Script should appear on stdout
    const stdoutCalls = stdoutWrite.mock.calls.map(([chunk]) => String(chunk));
    expect(stdoutCalls).toContain(script);
  });

  it("console.log sends script to stderr when routeLogsToStderr is active (demonstrating the need for process.stdout.write)", () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const logSpy = vi.fn();
    console.log = logSpy;

    setLoggerOverride({ level: "info", file: "/dev/null" });
    enableConsoleCapture();
    routeLogsToStderr();

    // This is what the current code does — console.log(script)
    // The patched console.log forwards to process.stderr.write when forceConsoleToStderr is set
    console.log("#compdef openclaw");

    // The original console.log should NOT have been called (it was redirected to stderr)
    expect(logSpy).not.toHaveBeenCalled();
    // Instead, stderr.write should have received the content
    const stderrCalls = stderrWrite.mock.calls.map(([chunk]) => String(chunk));
    const stderrOutput = stderrCalls.join("");
    expect(stderrOutput).toContain("#compdef openclaw");
  });
});
