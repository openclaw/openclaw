import { loadConfig } from "../../config/config.js";
import { loadCostUsageSummary } from "../../infra/session-cost-usage.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.js";
import type { GatewayRequestHandlers } from "./types.js";

export const usageHandlers: GatewayRequestHandlers = {
  "usage.status": async ({ respond }) => {
    const summary = await loadProviderUsageSummary();
    respond(true, summary, undefined);
  },
  "usage.cost": async ({ respond }) => {
    const config = loadConfig();
    const summary = await loadCostUsageSummary({ days: 30, config });
    respond(true, summary, undefined);
  },
};
