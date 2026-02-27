import type { MarketplaceScheduler } from "../marketplace/scheduler.js";
/**
 * Marketplace WebSocket method handlers for the Control UI.
 *
 * Methods:
 *   marketplace.status  — list available sellers, capacity, pricing info
 *   marketplace.opt-in  — toggle marketplace sharing on this node
 *   marketplace.opt-out — disable marketplace sharing
 *   marketplace.earnings — seller earnings breakdown
 *   marketplace.config   — get/set marketplace preferences
 */
import type { GatewayRequestHandlers } from "./types.js";
import { loadConfig } from "../../config/config.js";

let schedulerRef: MarketplaceScheduler | null = null;

/** Set the scheduler reference so handlers can access it. */
export function setMarketplaceScheduler(scheduler: MarketplaceScheduler): void {
  schedulerRef = scheduler;
}

export const marketplaceHandlers: GatewayRequestHandlers = {
  "marketplace.status": async ({ respond }) => {
    const config = loadConfig();
    const marketplaceConfig = config.gateway?.marketplace;
    const enabled = marketplaceConfig?.enabled === true;

    if (!enabled || !schedulerRef) {
      respond(true, {
        enabled: false,
        availableSellers: 0,
        totalSellers: 0,
        sellers: [],
      });
      return;
    }

    const sellers = schedulerRef.listSellers();
    const available = schedulerRef.availableCount();

    respond(true, {
      enabled: true,
      availableSellers: available,
      totalSellers: sellers.length,
      priceFraction: marketplaceConfig?.priceFraction ?? 0.6,
      platformFeePct: marketplaceConfig?.platformFeePct ?? 20,
      sellers: sellers.map((s) => ({
        nodeId: s.nodeId,
        status: s.status,
        activeRequests: s.activeRequests,
        maxConcurrent: s.maxConcurrent,
        performanceScore: s.performanceScore,
        totalCompleted: s.totalCompleted,
        totalFailed: s.totalFailed,
      })),
    });
  },

  "marketplace.opt-in": async ({ respond, client, context }) => {
    const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
    if (!nodeId) {
      respond(false, undefined, { code: "NO_NODE", message: "no node identity" });
      return;
    }

    const session = context.nodeRegistry.get(nodeId);
    if (!session) {
      respond(false, undefined, { code: "NOT_CONNECTED", message: "node not connected" });
      return;
    }

    session.marketplaceEnabled = true;
    session.marketplaceStatus = "idle";
    session.marketplaceActiveRequests = session.marketplaceActiveRequests ?? 0;
    session.marketplaceMaxConcurrent = session.marketplaceMaxConcurrent ?? 1;

    if (schedulerRef) {
      schedulerRef.syncFromNodeSession(session);
    }

    respond(true, { nodeId, marketplaceEnabled: true, status: "idle" });
  },

  "marketplace.opt-out": async ({ respond, client, context }) => {
    const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
    if (!nodeId) {
      respond(false, undefined, { code: "NO_NODE", message: "no node identity" });
      return;
    }

    const session = context.nodeRegistry.get(nodeId);
    if (!session) {
      respond(false, undefined, { code: "NOT_CONNECTED", message: "node not connected" });
      return;
    }

    session.marketplaceEnabled = false;
    session.marketplaceStatus = "active";

    if (schedulerRef) {
      schedulerRef.removeSeller(nodeId);
    }

    respond(true, { nodeId, marketplaceEnabled: false });
  },

  "marketplace.earnings": async ({ respond, client }) => {
    const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
    if (!nodeId) {
      respond(false, undefined, { code: "NO_NODE", message: "no node identity" });
      return;
    }

    if (!schedulerRef) {
      respond(true, {
        nodeId,
        totalCompleted: 0,
        totalFailed: 0,
        performanceScore: 0,
        estimatedEarningsCents: 0,
      });
      return;
    }

    const sellers = schedulerRef.listSellers();
    const seller = sellers.find((s) => s.nodeId === nodeId);

    respond(true, {
      nodeId,
      totalCompleted: seller?.totalCompleted ?? 0,
      totalFailed: seller?.totalFailed ?? 0,
      performanceScore: seller?.performanceScore ?? 0,
      status: seller?.status ?? "inactive",
    });
  },

  "marketplace.config": async ({ params, respond, client, context }) => {
    const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
    if (!nodeId) {
      respond(false, undefined, { code: "NO_NODE", message: "no node identity" });
      return;
    }

    const session = context.nodeRegistry.get(nodeId);
    if (!session) {
      respond(false, undefined, { code: "NOT_CONNECTED", message: "node not connected" });
      return;
    }

    // If params include updates, apply them.
    if (typeof params.maxConcurrent === "number" && params.maxConcurrent > 0) {
      session.marketplaceMaxConcurrent = params.maxConcurrent;
    }
    if (
      typeof params.payoutPreference === "string" &&
      (params.payoutPreference === "usd" || params.payoutPreference === "ai_token")
    ) {
      session.marketplacePayoutPreference = params.payoutPreference;
    }

    respond(true, {
      nodeId,
      marketplaceEnabled: session.marketplaceEnabled ?? false,
      status: session.marketplaceStatus ?? "active",
      maxConcurrent: session.marketplaceMaxConcurrent ?? 1,
      payoutPreference: session.marketplacePayoutPreference ?? "usd",
    });
  },
};
