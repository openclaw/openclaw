import { getSecurityHealthReport } from "../../security/security-health.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatError } from "../server-utils.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Security RPC handlers.
 *
 * security.health — returns the live SecurityHealthReport from the gateway
 * process, where the MonitorRunner singleton is actually running. This allows
 * the CLI to get accurate runner status instead of always showing "stopped".
 */
export const securityHandlers: GatewayRequestHandlers = {
  "security.health": async ({ respond }) => {
    try {
      const report = await getSecurityHealthReport();
      respond(true, report);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatError(err)));
    }
  },
};
