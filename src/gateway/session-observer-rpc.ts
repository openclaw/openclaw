import {
  ErrorCodes,
  validateSessionsObserverVisibilityParams,
} from "../../packages/gateway-protocol/src/index.js";
import { respondError } from "./server-methods/response.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import { defineValidatedGatewayHandler } from "./server-methods/validation.js";

export const sessionObserverHandlers: GatewayRequestHandlers = {
  "sessions.observer.visibility": defineValidatedGatewayHandler(
    "sessions.observer.visibility",
    validateSessionsObserverVisibilityParams,
    ({ params, respond, client, context }) => {
      if (!client?.connId || !context.isConnectionActive?.(client.connId)) {
        respondError(
          respond,
          ErrorCodes.FORBIDDEN,
          "Session observer visibility requires a connected client.",
        );
        return;
      }
      if (!context.sessionObserver) {
        respondError(respond, ErrorCodes.UNAVAILABLE, "Session observer is unavailable.");
        return;
      }
      const { visible } = params;
      context.sessionObserver.setConnectionVisibility(client.connId, visible);
      respond(true, { ok: true });
    },
  ),
};
