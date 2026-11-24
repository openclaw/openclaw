// Connect-failure facts on the Gateway snapshot. They are cleared and filled together so
// a later failure never shows an earlier failure's pairing or auth details.
import { readPairingConnectErrorDetails } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { readConnectionAuthReason } from "../lib/connection-hints.ts";

export const CLEARED_CONNECT_FAILURE = {
  lastError: null,
  lastErrorCode: null,
  lastErrorAuthReason: null,
  lastErrorPairing: null,
} as const;

/** Structured auth and pairing details of a rejected connect; startup waits carry none. */
export function readConnectFailureDetails(details: unknown, startupPending: boolean) {
  return startupPending
    ? { lastErrorAuthReason: null, lastErrorPairing: null }
    : {
        lastErrorAuthReason: readConnectionAuthReason(details),
        lastErrorPairing: readPairingConnectErrorDetails(details),
      };
}
