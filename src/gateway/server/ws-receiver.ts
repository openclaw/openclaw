import type { WebSocket } from "ws";
import type { GatewayRole } from "../role-policy.types.js";
import { MAX_PAYLOAD_BYTES } from "../server-constants.js";
import type { PrepareGatewayAuthenticatedReceive } from "./connection-transport.js";

type PayloadLimited = { _maxPayload?: number };
type GatewayReceiver = PayloadLimited & {
  _allowSynchronousEvents?: boolean;
  _extensions?: Record<string, PayloadLimited | undefined>;
};
const PERMESSAGE_DEFLATE_EXTENSION = "permessage-deflate";

function hasWritablePayloadLimit(target: PayloadLimited | undefined): target is PayloadLimited {
  return (
    typeof target?.["_maxPayload"] === "number" &&
    Object.getOwnPropertyDescriptor(target, "_maxPayload")?.writable === true
  );
}

/**
 * Resolves the ws receiver and every payload limit an authenticated frame passes through.
 * A negotiated permessage-deflate extension checks inflated size against its own copy of
 * the server maxPayload, so raising only the receiver would still reject compressed
 * post-auth frames above the preauth cap. Null when any limit is not writable.
 */
function gatewayReceiverPayloadLimits(
  socket: WebSocket,
): { receiver: GatewayReceiver; limits: PayloadLimited[] } | null {
  // SAFETY: ws owns these private per-frame fields; validate each before the handoff.
  const receiver = (socket as WebSocket & { _receiver?: GatewayReceiver })["_receiver"];
  if (!hasWritablePayloadLimit(receiver)) {
    return null;
  }
  const deflate = receiver["_extensions"]?.[PERMESSAGE_DEFLATE_EXTENSION];
  if (deflate === undefined) {
    return { receiver, limits: [receiver] };
  }
  return hasWritablePayloadLimit(deflate) ? { receiver, limits: [receiver, deflate] } : null;
}

/** Raises the authenticated frame limit on the receiver and its deflate extension together. */
export function raiseGatewayReceiverPayloadLimit(socket: WebSocket, maxPayload: number): boolean {
  const resolved = gatewayReceiverPayloadLimits(socket);
  if (!resolved) {
    return false;
  }
  for (const limit of resolved.limits) {
    limit["_maxPayload"] = maxPayload;
  }
  return true;
}

export function prepareGatewayReceiverHandoff(
  socket: WebSocket,
  role: GatewayRole,
): ReturnType<PrepareGatewayAuthenticatedReceive> {
  const resolved = gatewayReceiverPayloadLimits(socket);
  if (
    !resolved ||
    (role === "operator" &&
      (typeof resolved.receiver["_allowSynchronousEvents"] !== "boolean" ||
        Object.getOwnPropertyDescriptor(resolved.receiver, "_allowSynchronousEvents")?.writable !==
          true))
  ) {
    return {
      ok: false,
      error: {
        cause: "unsupported-websocket-receiver",
        message: "unsupported Gateway WebSocket receiver",
      },
    };
  }
  const { receiver, limits } = resolved;
  return {
    ok: true,
    value: () => {
      for (const limit of limits) {
        limit["_maxPayload"] = MAX_PAYLOAD_BYTES;
      }
      if (role === "operator") {
        receiver["_allowSynchronousEvents"] = true;
      }
    },
  };
}
