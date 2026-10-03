// Gateway node event types.
// Defines the narrowed context and event envelope for node-originated handlers.
import type { DesktopAvailability } from "../../packages/gateway-protocol/src/schema/environments.js";
import type { NodeHostStatsPayload } from "../../packages/gateway-protocol/src/schema/nodes.js";
import type { NodeHostStats } from "../shared/node-host-stats.js";
import type { PendingSystemRunEvent } from "./node-registry.invoke-stream.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

/** Runtime context available to node event handlers. */
export type NodeEventContext = Pick<
  GatewayRequestContext,
  | "deps"
  | "broadcastVoiceWakeChanged"
  | "addChatRun"
  | "removeChatRun"
  | "chatAbortControllers"
  | "dedupe"
  | "agentRunSeq"
  | "getHealthCache"
  | "refreshHealthSnapshot"
  | "loadGatewayModelCatalog"
> & {
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  nodeSubscribe: (nodeId: string, sessionKey: string, connId?: string) => void | Promise<void>;
  nodeUnsubscribe: (nodeId: string, sessionKey: string, connId?: string) => void | Promise<void>;
  loadGatewayModelCatalogSnapshot?: GatewayRequestContext["loadGatewayModelCatalogSnapshot"];
  authorizeNodeSystemRunEvent: (params: {
    nodeId: string;
    connId?: string;
    runId?: string;
    sessionKey: string;
    event: "exec.started" | "exec.finished" | "exec.denied";
  }) => boolean | Pick<PendingSystemRunEvent, "invocationDeliveryContext">;
  updateNodePresenceActivity?: (params: {
    nodeId: string;
    connId?: string;
    idleSeconds: number;
    source?: "app" | "system";
    saturated?: boolean;
  }) => { lastActiveAtMs: number; presenceUpdatedAtMs: number } | null;
  clearNodePresenceActivity?: (params: { nodeId: string; connId?: string }) => boolean | null;
  updateNodeHostStats?: (params: {
    nodeId: string;
    connId?: string;
    stats: NodeHostStatsPayload;
  }) => NodeHostStats | null;
  updateNodeDesktopAvailability?: (params: {
    nodeId: string;
    connId?: string;
    availability: DesktopAvailability;
  }) => boolean | null;
  logGateway: { warn: (msg: string) => void };
};

/** Raw event envelope received from connected node clients. */
export type NodeEvent = {
  event: string;
  payloadJSON?: string | null;
};
