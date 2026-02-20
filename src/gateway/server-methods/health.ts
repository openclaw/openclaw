import type { GatewayRequestHandlers } from "./types.js";
import { getStatusSummary } from "../../commands/status.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  getHealthBackgroundRefreshMinIntervalMs,
  HEALTH_REFRESH_INTERVAL_MS,
} from "../server-constants.js";
import { formatError } from "../server-utils.js";
import { formatForLog } from "../ws-log.js";

const ADMIN_SCOPE = "operator.admin";
let backgroundRefreshInFlight: Promise<void> | null = null;
let nextBackgroundRefreshAt = 0;

function scheduleBackgroundRefresh(params: {
  refreshHealthSnapshot: (opts?: { probe?: boolean }) => Promise<unknown>;
  logHealth: { error: (msg: string) => void };
}) {
  if (backgroundRefreshInFlight) {
    return;
  }
  const now = Date.now();
  if (now < nextBackgroundRefreshAt) {
    return;
  }
  nextBackgroundRefreshAt = now + getHealthBackgroundRefreshMinIntervalMs();
  backgroundRefreshInFlight = params
    .refreshHealthSnapshot({ probe: false })
    .then(() => undefined)
    .catch((err) => {
      params.logHealth.error(`background health refresh failed: ${formatError(err)}`);
    })
    .finally(() => {
      backgroundRefreshInFlight = null;
    });
}

export function __resetHealthBackgroundRefreshStateForTest() {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    return;
  }
  backgroundRefreshInFlight = null;
  nextBackgroundRefreshAt = 0;
}

export const healthHandlers: GatewayRequestHandlers = {
  health: async ({ respond, context, params }) => {
    const { getHealthCache, refreshHealthSnapshot, logHealth } = context;
    const wantsProbe = params?.probe === true;
    const now = Date.now();
    const cached = getHealthCache();
    if (!wantsProbe && cached && now - cached.ts < HEALTH_REFRESH_INTERVAL_MS) {
      respond(true, cached, undefined, { cached: true });
      scheduleBackgroundRefresh({ refreshHealthSnapshot, logHealth });
      return;
    }
    try {
      const snap = await refreshHealthSnapshot({ probe: wantsProbe });
      respond(true, snap, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  status: async ({ respond, client }) => {
    const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    const status = await getStatusSummary({
      includeSensitive: scopes.includes(ADMIN_SCOPE),
    });
    respond(true, status, undefined);
  },
};
