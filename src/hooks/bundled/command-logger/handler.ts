/**
 * Example hook handler: Log all commands to a file
 *
 * This handler demonstrates how to create a hook that logs all command events
 * to a centralized log file for audit/debugging purposes.
 *
 * To enable this handler, add it to your config:
 *
 * ```json
 * {
 *   "hooks": {
 *     "internal": {
 *       "enabled": true,
 *       "handlers": [
 *         {
 *           "event": "command",
 *           "module": "./hooks/handlers/command-logger.ts"
 *         }
 *       ]
 *     }
 *   }
 * }
 * ```
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HookHandler } from "../../hooks.js";

/**
 * Log all command events to a file
 */
const logCommand: HookHandler = async (event) => {
  // Only trigger on command events
  if (event.type !== "command") {
    return;
  }

  try {
    // Create log directory
    const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
    const logDir = path.join(stateDir, "logs");
    await fs.mkdir(logDir, { recursive: true });

    // Append to command log file
    const logFile = path.join(logDir, "commands.log");
    const logLine =
      JSON.stringify({
        timestamp: event.timestamp.toISOString(),
        action: event.action,
        sessionKey: event.sessionKey,
        senderId: event.context.senderId ?? "unknown",
        source: event.context.commandSource ?? "unknown",
      }) + "\n";

    await fs.appendFile(logFile, logLine, "utf-8");
  } catch (err) {
    console.error(
      "[command-logger] Failed to log command:",
      err instanceof Error ? err.message : String(err),
    );
  }
};

export default logCommand;
