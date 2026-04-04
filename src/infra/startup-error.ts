/**
 * Startup error diagnostics for OpenClaw Gateway.
 *
 * On uncaught exceptions during startup, writes a human-readable error report to:
 *   ~/.openclaw/logs/startup-error.txt
 *
 * The file is cleared automatically when the gateway starts up successfully
 * (i.e. when startGatewayServer() completes without throwing).
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const STARTUP_ERROR_FILE = "startup-error.txt";

let errorWritten = false;

/** Return the path to the startup error log file. */
export function startupErrorPath(env: NodeJS.ProcessEnv = process.env): string {
  const logsDir = path.join(resolveStateDir(env), "logs");
  return path.join(logsDir, STARTUP_ERROR_FILE);
}

/**
 * Write an uncaught exception to startup-error.txt with a human-readable header
 * and stack trace. Appends if multiple errors fire before the file is cleared.
 */
export function writeStartupError(
  err: unknown,
  label = "Uncaught exception",
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const filePath = startupErrorPath(env);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const timestamp = new Date().toISOString();
    const heading = `[${timestamp}] ${label}`;
    const body = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);

    const content = ["", "=".repeat(72), heading, "=".repeat(72), body, ""].join("\n");

    fs.writeFileSync(filePath, content, { flag: errorWritten ? "a" : "w", encoding: "utf8" });
    errorWritten = true;
  } catch (writeErr) {
    // Swallow. We don't want diagnostics to crash the process.
    console.error("[openclaw] Failed to write startup error log:", writeErr);
  }
}

/**
 * Clear the startup error file on successful gateway startup.
 * Call this after startGatewayServer() resolves without throwing.
 */
export function clearStartupError(): void {
  try {
    const filePath = startupErrorPath();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    errorWritten = false;
  } catch {
    // Swallow.
  }
}

/**
 * Read the current startup error content, if any.
 * Returns null if no error has been logged.
 */
export function readStartupError(): string | null {
  try {
    const filePath = startupErrorPath();
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}
