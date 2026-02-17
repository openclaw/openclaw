import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const wsMetricsHandlers: GatewayRequestHandlers = {
  "ws.metrics": async ({ respond, context }) => {
    const { clients, getWsMetrics } = context;
    try {
      const metrics = getWsMetrics(clients);
      respond(true, metrics, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
    }
  },

  "ws.clients": async ({ respond, context, client }) => {
    // Only allow admin scope to see detailed client stats
    const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    if (!scopes.includes("operator.admin")) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.admin"),
      );
      return;
    }

    const { getWsClientStats } = context;
    try {
      const stats = getWsClientStats();
      respond(true, stats, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
    }
  },
};
