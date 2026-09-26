import type { WebSocket } from "ws";
import type { GatewayRole } from "../role-policy.types.js";
import { MAX_PAYLOAD_BYTES } from "../server-constants.js";
import type { PrepareGatewayAuthenticatedReceive } from "./connection-transport.js";

type PayloadLimited = { _maxPayload?: number };
type GatewayReceiver = PayloadLimited & {
  _allowSynchronousEvents?: boolean;
};

function hasWritablePayloadLimit(target: PayloadLimited | undefined): target is PayloadLimited {
  return (
    typeof target?.["_maxPayload"] === "number" &&
    Object.getOwnPropertyDescriptor(target, "_maxPayload")?.writable === true
  );
}

function gatewayReceiver(socket: WebSocket): GatewayReceiver | null {
  // SAFETY: ws owns these private per-frame fields; validate each before the handoff.
  const receiver = (socket as WebSocket & { _receiver?: GatewayReceiver })["_receiver"];
  return hasWritablePayloadLimit(receiver) ? receiver : null;
}

/** Raises the authenticated frame limit after the connection is admitted. */
export function raiseGatewayReceiverPayloadLimit(socket: WebSocket, maxPayload: number): boolean {
  const receiver = gatewayReceiver(socket);
  if (!receiver) {
    return false;
  }
  receiver["_maxPayload"] = maxPayload;
  return true;
}

export function prepareGatewayReceiverHandoff(
  socket: WebSocket,
  role: GatewayRole,
): ReturnType<PrepareGatewayAuthenticatedReceive> {
  const receiver = gatewayReceiver(socket);
  if (
    !receiver ||
    (role === "operator" &&
      (typeof receiver["_allowSynchronousEvents"] !== "boolean" ||
        Object.getOwnPropertyDescriptor(receiver, "_allowSynchronousEvents")?.writable !== true))
  ) {
    return {
      ok: false,
      error: {
        cause: "unsupported-websocket-receiver",
        message: "unsupported Gateway WebSocket receiver",
      },
    };
  }
  return {
    ok: true,
    value: () => {
      receiver["_maxPayload"] = MAX_PAYLOAD_BYTES;
      if (role === "operator") {
        receiver["_allowSynchronousEvents"] = true;
      }
    },
  };
}
