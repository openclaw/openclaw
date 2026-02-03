import { createSubsystemLogger } from "./subsystem.js";
import { initializeTestLogFile, writeToTestLogFile, getTestLogFilePath } from "./test-log-file.js";

/**
 * Logger for test execution output.
 *
 * By default, test logs are suppressed in console to avoid noise during
 * development. Set CLAWDBRAIN_TEST_LOGS=1 to enable test logging to console.
 *
 * When suppressed, logs are written to a temporary file that can be accessed
 * for debugging test failures.
 */
const baseLogger = createSubsystemLogger("test-runner");

// Initialize test log file if in test environment and logs are suppressed
let testLogFileInitialized = false;
function ensureTestLogFile(): void {
  if (testLogFileInitialized) {
    return;
  }
  if (isTestEnvironment() && !shouldShowTestLogs()) {
    initializeTestLogFile();
    testLogFileInitialized = true;
  }
}

// Wrap base logger to also write to file when suppressed
export const testLogger = {
  ...baseLogger,
  trace: (message: string, meta?: Record<string, unknown>) => {
    ensureTestLogFile();
    if (!shouldShowTestLogs()) {
      writeToTestLogFile(`[TRACE] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
    }
    baseLogger.trace(message, meta);
  },
  debug: (message: string, meta?: Record<string, unknown>) => {
    ensureTestLogFile();
    if (!shouldShowTestLogs()) {
      writeToTestLogFile(`[DEBUG] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
    }
    baseLogger.debug(message, meta);
  },
  info: (message: string, meta?: Record<string, unknown>) => {
    ensureTestLogFile();
    if (!shouldShowTestLogs()) {
      writeToTestLogFile(`[INFO] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
    }
    baseLogger.info(message, meta);
  },
  warn: (message: string, meta?: Record<string, unknown>) => {
    ensureTestLogFile();
    if (!shouldShowTestLogs()) {
      writeToTestLogFile(`[WARN] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
    }
    baseLogger.warn(message, meta);
  },
  error: (message: string, meta?: Record<string, unknown>) => {
    ensureTestLogFile();
    if (!shouldShowTestLogs()) {
      writeToTestLogFile(`[ERROR] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
    }
    baseLogger.error(message, meta);
  },
  fatal: (message: string, meta?: Record<string, unknown>) => {
    ensureTestLogFile();
    if (!shouldShowTestLogs()) {
      writeToTestLogFile(`[FATAL] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
    }
    baseLogger.fatal(message, meta);
  },
};

/**
 * Check if test logs should be shown in console.
 * Default: false (suppressed)
 * Enable via: CLAWDBRAIN_TEST_LOGS=1
 */
export function shouldShowTestLogs(): boolean {
  return process.env.CLAWDBRAIN_TEST_LOGS === "1";
}

/**
 * Check if we're running in a test environment.
 */
export function isTestEnvironment(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test" ||
    typeof (globalThis as { expect?: unknown }).expect !== "undefined"
  );
}

/**
 * Get the path to the current test log file (when logs are suppressed).
 * Returns null if test logs are shown in console or no test is running.
 */
export function getTestLogFile(): string | null {
  return getTestLogFilePath();
}
