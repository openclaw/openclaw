import { listActiveDelegations } from "../../orchestration/delegation-tracker-sqlite.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const delegationsHandlers: GatewayRequestHandlers = {
  "sessions.delegations": async ({ params, respond }) => {
    const p = params as {
      sessionKey?: unknown;
      includeCompleted?: unknown;
      limit?: unknown;
    };

    const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey required"));
      return;
    }

    const includeCompleted = typeof p.includeCompleted === "boolean" ? p.includeCompleted : false;
    const limit = typeof p.limit === "number" && p.limit > 0 ? Math.min(p.limit, 100) : undefined;

    try {
      const delegations = listActiveDelegations(sessionKey, {
        includeCompleted,
        limit,
      });
      respond(true, { delegations });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, msg));
    }
  },
};
