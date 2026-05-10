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

import { formatErrorMessage } from "../../../infra/errors.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { recordCommandLogEntry } from "./store.sqlite.js";

const log = createSubsystemLogger("command-logger");

/**
 * Log all command events to a file
 */
const logCommand: HookHandler = async (event) => {
  // Only trigger on command events
  if (event.type !== "command") {
    return;
  }

  try {
    recordCommandLogEntry({
      timestamp: event.timestamp,
      action: event.action,
      sessionKey: event.sessionKey,
      senderId: typeof event.context.senderId === "string" ? event.context.senderId : "unknown",
      source:
        typeof event.context.commandSource === "string" ? event.context.commandSource : "unknown",
    });
  } catch (err) {
    const message = formatErrorMessage(err);
    log.error(`Failed to log command: ${message}`);
  }
};

export default logCommand;
