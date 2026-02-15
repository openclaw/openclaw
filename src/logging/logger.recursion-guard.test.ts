import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableConsoleCapture } from "./console.js";
import { resetLogger, setLoggerOverride } from "./logger.js";
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
let originalConfigPath: string | undefined;

beforeEach(() => {
  snapshot = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    trace: console.trace,
  };
  originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
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
  if (originalConfigPath === undefined) {
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else {
    process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
  }
});

describe("logger recursion guard", () => {
  it("avoids recursive stack overflow when config loading fails under console capture", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-recursion-"));
    try {
      const configPath = path.join(tmpDir, "openclaw.json");

      // Circular include: guaranteed config load failure for exercising error path.
      await writeFile(configPath, `{ "$include": "./openclaw.json" }\n`, "utf-8");
      process.env.OPENCLAW_CONFIG_PATH = configPath;

      enableConsoleCapture();

      expect(() => console.error("trigger config load")).not.toThrow();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
