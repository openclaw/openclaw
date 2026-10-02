import {
  ErrorCodes,
  errorShape,
  validateSessionsObserverVisibilityParams,
} from "../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import { defineValidatedGatewayHandler } from "./server-methods/validation.js";

export const sessionObserverHandlers: GatewayRequestHandlers = {
  "sessions.observer.visibility": defineValidatedGatewayHandler(
    "sessions.observer.visibility",
    validateSessionsObserverVisibilityParams,
    ({ params, respond, client, context }) => {
      if (!client?.connId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.FORBIDDEN,
            "Session observer visibility requires a connected client.",
          ),
        );
        return;
      }
      if (!context.sessionObserver) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Session observer is unavailable."),
        );
        return;
      }
      const { visible } = params;
      context.sessionObserver.setConnectionVisibility(client.connId, visible);
      respond(true, { ok: true });
    },
  ),
};
