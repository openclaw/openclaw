import { isPrivateNodeInvokeCommand } from "../infra/node-commands.js";
import { logRejectedLargePayload } from "../logging/diagnostic-payload.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { MAX_BUFFERED_BYTES, WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import { closeGatewayTransportWithGrace } from "./server/connection-transport-close.js";
import type { GatewayConnectionTransport } from "./server/connection-transport.js";

export type NodeEventSendResult =
  | { sent: true }
  | {
      sent: false;
      reason:
        | "connection_changed"
        | "client_invalidated"
        | "pairing_not_current"
        | "pairing_state_unavailable"
        | "event_transport_refused"
        | "socket_not_open"
        | "socket_buffer_limit"
        | "send_or_serialization_exception";
      socketReadyState?: number;
      bufferedBytes?: number;
    };

const log = createSubsystemLogger("gateway/nodes");

export function logNodeInvokeDispatchRefusal(params: {
  node: { nodeId: string; connId: string };
  invokeId: string;
  command: string;
  delivery: Extract<NodeEventSendResult, { sent: false }>;
}): void {
  try {
    log.warn("node invoke dispatch refused", {
      nodeId: params.node.nodeId,
      connId: params.node.connId,
      invokeId: params.invokeId,
      command: isPrivateNodeInvokeCommand(params.command) ? params.command.trim() : "public",
      reason: params.delivery.reason,
      socketReadyState: params.delivery.socketReadyState,
      bufferedBytes: params.delivery.bufferedBytes,
      remoteEffects: "unknown",
    });
  } catch {
    // Observations cannot alter settlement or expose invoke payloads and transport errors.
  }
}

export function sendNodeWebSocketEvent(
  socket: GatewayConnectionTransport,
  serialize: () => string,
): NodeEventSendResult {
  const socketReadyState = socket.readyState;
  const bufferedBytes = socket.bufferedAmount;
  // ws.send() does not throw after entering CLOSING; it only accounts unsent bytes.
  if (socketReadyState !== WEBSOCKET_OPEN_READY_STATE) {
    return { sent: false, reason: "socket_not_open", socketReadyState, bufferedBytes };
  }
  if (bufferedBytes > MAX_BUFFERED_BYTES) {
    logRejectedLargePayload({
      surface: "gateway.ws.outbound_buffer",
      bytes: bufferedBytes,
      limitBytes: MAX_BUFFERED_BYTES,
      reason: "ws_send_buffer_close",
    });
    closeGatewayTransportWithGrace(socket, 1008, "slow consumer");
    return { sent: false, reason: "socket_buffer_limit", socketReadyState, bufferedBytes };
  }
  try {
    socket.send(serialize());
    return { sent: true };
  } catch {
    return {
      sent: false,
      reason: "send_or_serialization_exception",
      socketReadyState,
      bufferedBytes,
    };
  }
}
