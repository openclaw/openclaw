import { WEBSOCKET_CLOSE_GRACE_MS } from "../server-constants.js";
import type { GatewayConnectionTransport } from "./connection-transport.js";

const closingTransports = new WeakSet<GatewayConnectionTransport>();

export function closeGatewayTransportWithGrace(
  socket: GatewayConnectionTransport,
  code: number,
  reason: string,
): void {
  if (closingTransports.has(socket)) {
    return;
  }
  closingTransports.add(socket);
  const handleClose = () => {
    clearTimeout(fallback);
    socket.off("close", handleClose);
    closingTransports.delete(socket);
  };
  const terminate = () => {
    try {
      socket.terminate();
    } catch {
      /* cleanup is best effort */
    }
  };
  socket.once("close", handleClose);
  const fallback = setTimeout(() => {
    terminate();
  }, WEBSOCKET_CLOSE_GRACE_MS);
  fallback.unref?.();
  try {
    socket.close(code, reason);
  } catch {
    clearTimeout(fallback);
    terminate();
  }
}
