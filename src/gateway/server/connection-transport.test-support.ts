import type { WebSocket } from "ws";
import type { SerializedGatewayFrame } from "../serialized-json.js";
import type { GatewayConnectionTransport } from "./connection-transport.js";

/** Adapt physical test peers whose protocol is already owned by the fixture. */
export function gatewayTestTextTransport(socket: WebSocket): GatewayConnectionTransport {
  return {
    get readyState() {
      return socket.readyState;
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    send(
      frame: string | Buffer | SerializedGatewayFrame,
      options?: { binary: false } | ((error?: Error) => void),
      callback?: (error?: Error) => void,
    ) {
      socket.send(frame.toString(), typeof options === "function" ? options : callback);
    },
    close: (code, reason) => socket.close(code, reason),
    terminate: () => socket.terminate(),
    on: (event, listener) => socket.on(event, listener),
    off: (event, listener) => socket.off(event, listener),
    once: (event, listener) => socket.once(event, listener),
  };
}
