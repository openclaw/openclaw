import type { GatewayRequestHandlers } from "./types.js";
import { getStatusSummary } from "../../commands/status.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { HEALTH_REFRESH_INTERVAL_MS } from "../server-constants.js";
import { formatError } from "../server-utils.js";
import { formatForLog } from "../ws-log.js";

export const healthHandlers: GatewayRequestHandlers = {
  health: async ({ respond, context, params }) => {
    const {
      getHealthCache,
      getCurrentChannelBeingProbed,
      isHealthRefreshInProgress,
      refreshHealthSnapshot,
      logHealth,
    } = context;
    const wantsProbe = params?.probe === true;
    const now = Date.now();
    const cached = getHealthCache();
    if (!wantsProbe && cached && now - cached.ts < HEALTH_REFRESH_INTERVAL_MS) {
      respond(true, cached, undefined, { cached: true });
      void refreshHealthSnapshot({ probe: false }).catch((err) =>
        logHealth.error(`background health refresh failed: ${formatError(err)}`),
      );
      return;
    }
    // When a refresh is in progress and client doesn't want full probe, return cached
    // immediately. Avoids blocking probe/status on a slow channel (e.g. iMessage).
    if (!wantsProbe && isHealthRefreshInProgress() && cached) {
      respond(true, cached, undefined, { cached: true, refreshInProgress: true });
      return;
    }
    try {
      const snap = await refreshHealthSnapshot({ probe: wantsProbe });
      respond(true, snap, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  status: async ({ respond }) => {
    const status = await getStatusSummary();
    respond(true, status, undefined);
  },
  "health.probeStatus": async ({ respond, context }) => {
    const { getCurrentChannelBeingProbed } = context;
    const currentChannel = getCurrentChannelBeingProbed();
    respond(true, { currentChannel: currentChannel ?? undefined }, undefined);
  },
};
