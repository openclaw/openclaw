import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

export const connectHandlers: GatewayRequestHandlers = {
  connect: ({ respond }) => {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "connect is only valid as the first request"),
    );
  },
};
