import { logRejectedLargePayload } from "../logging/diagnostic-payload.js";
import { MAX_BUFFERED_BYTES, WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import { closeGatewayTransportWithGrace } from "./server/connection-transport-close.js";
import type { GatewayConnectionTransport } from "./server/connection-transport.js";

export function sendNodeWebSocketEvent(
  socket: GatewayConnectionTransport,
  serialize: () => string,
): boolean {
  // ws.send() does not throw after entering CLOSING; it only accounts unsent bytes.
  if (socket.readyState !== WEBSOCKET_OPEN_READY_STATE) {
    return false;
  }
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    logRejectedLargePayload({
      surface: "gateway.ws.outbound_buffer",
      bytes: socket.bufferedAmount,
      limitBytes: MAX_BUFFERED_BYTES,
      reason: "ws_send_buffer_close",
    });
    closeGatewayTransportWithGrace(socket, 1008, "slow consumer");
    return false;
  }
  try {
    socket.send(serialize());
    return true;
  } catch {
    return false;
  }
}
