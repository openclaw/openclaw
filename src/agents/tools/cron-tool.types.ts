// Cron tool type declarations shared with the cron tool implementation.
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import type { callGatewayTool } from "./gateway.js";

export type CronCreatorToolAllowlistEntry =
  | string
  | {
      name: string;
      pluginId?: string;
    };

export type NormalizedCronCreatorTool = {
  name: string;
  pluginId?: string;
};

export type CronToolOptions = {
  agentSessionKey?: string;
  currentDeliveryContext?: DeliveryContext;
  /**
   * Effective tool surface visible to the caller that created or edited a cron job.
   * Isolated cron runs use a fresh session, so agent-origin jobs need this cap
   * persisted on agentTurn payloads before the original session policy is lost.
   */
  creatorToolAllowlist?: CronCreatorToolAllowlistEntry[];
  selfRemoveOnlyJobId?: string;
};

export type CronToolCallerScope = {
  kind: "agentTool";
  agentId: string;
};

export type GatewayToolCaller = typeof callGatewayTool;

export type CronToolDeps = {
  callGatewayTool?: GatewayToolCaller;
};

export type ChatMessage = {
  role?: unknown;
  content?: unknown;
};
