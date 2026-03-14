import { getHealthSnapshot } from "../../commands/health.js";
import { getStatusSummary } from "../../commands/status.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { setHealthCache } from "../server/health-state.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

const ADMIN_SCOPE = "operator.admin";

export const healthHandlers: GatewayRequestHandlers = {
  health: async ({ respond, context, params }) => {
    const wantsProbe = params?.probe === true;
    try {
      const snap = await getHealthSnapshot({
        probe: wantsProbe,
        runtimeSnapshot: context.getRuntimeSnapshot(),
      });
      setHealthCache(snap);
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
