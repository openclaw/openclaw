import type { GatewayWsClient } from "./server/ws-types.js";

export type SessionEventRecipientCheck = (
  client: GatewayWsClient,
  sessionKeys: readonly string[],
  agentId?: string,
  event?: string,
  payload?: unknown,
) => boolean;

export type {
  SessionEventProjection,
  PrepareSessionEventProjection,
  GatewayBroadcastOpts,
  GatewayBroadcastFn,
  GatewayBroadcastToConnIdsFn,
  GatewayBufferedAmountFn,
  GatewayPluginEventScope,
  GatewayPluginEventBroadcastFn,
} from "./server-methods/shared-types.js";
