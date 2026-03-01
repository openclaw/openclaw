import type { IncomingMessage, ServerResponse } from "node:http";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { isLoopbackAddress } from "./net.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type LoopbackGuardResult = {
  allowed: boolean;
  statusCode?: number;
  message?: string;
};

/**
 * Creates a loopback guard for Control UI requests.
 *
 * Behavior:
 * - Loopback addresses (127.0.0.1, ::1, ::ffff:127.0.0.1) are always allowed.
 * - Non-loopback addresses trigger a warning in default mode but are allowed.
 * - In strict mode, non-loopback addresses are rejected with HTTP 403.
 * - **Undefined remote addresses**: In strict mode, rejected with 403.
 *   In default mode, allowed with a warning (security trade-off for edge cases).
 *
 * @param log - Subsystem logger for warnings
 * @param strictLoopback - If true, reject non-loopback requests with 403
 */
export function createControlUiLoopbackGuard(
  log: SubsystemLogger,
  strictLoopback: boolean = false,
): (req: IncomingMessage, res: ServerResponse) => LoopbackGuardResult {
  return (req: IncomingMessage, res: ServerResponse): LoopbackGuardResult => {
    const remoteAddress = req.socket.remoteAddress;

    // Check if address is loopback
    if (remoteAddress && isLoopbackAddress(remoteAddress)) {
      return { allowed: true };
    }

    // Non-loopback or undefined address
    const addressDisplay = remoteAddress ?? "unknown";

    if (strictLoopback) {
      // Strict mode: reject with 403
      log.warn(`Control UI access rejected from non-loopback address: ${addressDisplay}`);
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Forbidden: Control UI is only accessible from localhost");
      return { allowed: false, statusCode: 403, message: "Forbidden" };
    }

    // Default mode: warn but allow
    log.warn(
      `Control UI accessed from non-loopback address: ${addressDisplay}. ` +
        `Consider binding to loopback only or enabling strictLoopback.`,
    );
    return { allowed: true };
  };
}
