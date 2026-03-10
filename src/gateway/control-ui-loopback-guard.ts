import type { IncomingMessage, ServerResponse } from "node:http";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { isLoopbackAddress } from "./net.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type LoopbackGuardResult = {
  allowed: boolean;
  statusCode?: number;
  message?: string;
};

export function createControlUiLoopbackGuard(
  log: SubsystemLogger,
  strictLoopback: boolean = false,
): (req: IncomingMessage, res: ServerResponse) => LoopbackGuardResult {
  return (req: IncomingMessage, res: ServerResponse): LoopbackGuardResult => {
    const remoteAddress = req.socket.remoteAddress;

    if (remoteAddress && isLoopbackAddress(remoteAddress)) {
      return { allowed: true };
    }

    const addressDisplay = remoteAddress ?? "unknown";

    if (strictLoopback) {
      log.warn(`Control UI access rejected from non-loopback address: ${addressDisplay}`);
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Forbidden: Control UI is only accessible from localhost");
      return { allowed: false, statusCode: 403, message: "Forbidden" };
    }

    log.warn(
      `Control UI accessed from non-loopback address: ${addressDisplay}. ` +
        `Consider binding to loopback only or enabling strictLoopback.`,
    );
    return { allowed: true };
  };
}
