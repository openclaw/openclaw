import { listVisiblePendingApprovalRequests } from "./approval-record-lookup.js";
import type { GatewayRequestHandlers } from "./types.js";

export const systemAgentApprovalHandlers: GatewayRequestHandlers = {
  "openclaw.approval.list": async ({ respond, client, context }) => {
    const manager = context.systemAgentApprovalManager;
    respond(
      true,
      manager
        ? await listVisiblePendingApprovalRequests({
            manager,
            client,
            ...(client?.authenticatedUserProfile ? { getCfg: context.getRuntimeConfig } : {}),
          })
        : [],
      undefined,
    );
  },
};
