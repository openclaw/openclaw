import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let testLogFilePath: string | null = null;
let testLogFileStream: fs.WriteStream | null = null;

/**
 * Get the path to the current test log file.
 * Returns null if test logs are being shown in console or no test is running.
 */
export function getTestLogFilePath(): string | null {
  return testLogFilePath;
}

/**
 * Initialize test log file for capturing suppressed test output.
 * Called automatically when test environment is detected and logs are suppressed.
 */
export function initializeTestLogFile(): string {
  if (testLogFilePath) {
    return testLogFilePath;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const pid = process.pid;
  const filename = `clawdbrain-test-${timestamp}-${pid}.log`;
  testLogFilePath = path.join(os.tmpdir(), filename);

  // Create write stream for appending
  testLogFileStream = fs.createWriteStream(testLogFilePath, { flags: "a" });

  // Write header
  testLogFileStream.write(`=== Clawdbrain Test Log ===\n`);
  testLogFileStream.write(`Started: ${new Date().toISOString()}\n`);
  testLogFileStream.write(`PID: ${pid}\n`);
  testLogFileStream.write(`Location: ${testLogFilePath}\n`);
  testLogFileStream.write(`\n`);
  testLogFileStream.write(
    `Note: Test logs are suppressed from console. Set CLAWDBRAIN_TEST_LOGS=1 to enable.\n`,
  );
  testLogFileStream.write(`${"=".repeat(80)}\n\n`);

  // Log to stderr so it's discoverable even when stdout is captured
  process.stderr.write(`[test-runner] Logs suppressed. Writing to: ${testLogFilePath}\n`);

  return testLogFilePath;
}

/**
 * Write a log message to the test log file.
 * No-op if test logs are enabled (showing in console) or no file is initialized.
 */
export function writeToTestLogFile(message: string): void {
  if (!testLogFileStream) {
    return;
  }

  const timestamp = new Date().toISOString();
  testLogFileStream.write(`[${timestamp}] ${message}\n`);
}

/**
 * Close the test log file stream.
 * Called automatically on process exit.
 */
export function closeTestLogFile(): void {
  if (testLogFileStream) {
    testLogFileStream.write(`\n${"=".repeat(80)}\n`);
    testLogFileStream.write(`Ended: ${new Date().toISOString()}\n`);
    testLogFileStream.end();
    testLogFileStream = null;
  }
}

// Auto-close on process exit
if (typeof process !== "undefined") {
  process.on("exit", closeTestLogFile);
  process.on("SIGINT", () => {
    closeTestLogFile();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    closeTestLogFile();
    process.exit(143);
  });
}
