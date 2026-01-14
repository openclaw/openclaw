import { getStatusSummary } from "../../commands/status.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { HEALTH_REFRESH_INTERVAL_MS } from "../server-constants.js";
import { formatError } from "../server-utils.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

export const healthHandlers: GatewayRequestHandlers = {
  health: async ({ respond, context }) => {
    const { getHealthCache, refreshHealthSnapshot, logHealth } = context;
    const now = Date.now();
    const cached = getHealthCache();
    if (cached && now - cached.ts < HEALTH_REFRESH_INTERVAL_MS) {
      respond(true, cached, undefined, { cached: true });
      void refreshHealthSnapshot({ probe: false }).catch((err) =>
        logHealth.error(`background health refresh failed: ${formatError(err)}`),
      );
      return;
    }
    try {
      const snap = await refreshHealthSnapshot({ probe: false });
      respond(true, snap, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  status: async ({ respond }) => {
    const status = await getStatusSummary();
    respond(true, status, undefined);
  },
};
