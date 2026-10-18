import type {
  GatewayBroadcastToConnIdsFn,
  GatewayBufferedAmountFn,
} from "../server-broadcast-types.js";
import { TERMINAL_EVENT_DATA } from "./session-types.js";
export { TERMINAL_EVENT_DATA, TERMINAL_EVENT_EXIT } from "./session-types.js";

/** Adapts terminal ownership to targeted gateway delivery and pressure state. */
export function createTerminalSessionTransport(
  broadcastToConnIds: GatewayBroadcastToConnIdsFn,
  getBufferedAmount: GatewayBufferedAmountFn,
) {
  return {
    emit: (connId: string, event: string, payload: unknown) =>
      broadcastToConnIds(event, payload, new Set([connId]), {
        // PTY flow control is primary; dropping is the last-resort socket cap guard.
        dropIfSlow: event === TERMINAL_EVENT_DATA,
      }),
    getBufferedAmount,
  };
}
