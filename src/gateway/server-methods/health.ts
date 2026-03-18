import { getStatusSummary } from "../../commands/status.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { HEALTH_REFRESH_INTERVAL_MS } from "../server-constants.js";
import { formatError } from "../server-utils.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

const ADMIN_SCOPE = "operator.admin";

export type HealthSnapshotPayload = {
  live: boolean;
  ready: boolean;
  failing: string[];
  uptimeMs: number | null;
  checkedAt: number;
};

export const healthHandlers: GatewayRequestHandlers = {
  "health.snapshot": async ({ respond, context }) => {
    const getReadiness = context.getReadiness;
    const checkedAt = Date.now();
    if (!getReadiness) {
      respond(true, {
        live: true,
        ready: true,
        failing: [],
        uptimeMs: null,
        checkedAt,
      } satisfies HealthSnapshotPayload);
      return;
    }
    try {
      const result = getReadiness();
      respond(true, {
        live: true,
        ready: result.ready,
        failing: result.failing ?? [],
        uptimeMs: result.uptimeMs,
        checkedAt,
      } satisfies HealthSnapshotPayload);
    } catch {
      respond(true, {
        live: true,
        ready: false,
        failing: ["internal"],
        uptimeMs: 0,
        checkedAt,
      } satisfies HealthSnapshotPayload);
    }
  },
  health: async ({ respond, context, params }) => {
    const { getHealthCache, refreshHealthSnapshot, logHealth } = context;
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
