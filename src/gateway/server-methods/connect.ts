import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Rejects post-handshake connect requests; real connect auth is handled before RPC dispatch. */
export const connectHandlers: GatewayRequestHandlers = {
  connect: ({ respond }) => {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "connect is only valid as the first request"),
    );
  },
};
