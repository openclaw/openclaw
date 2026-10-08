// Gateway node event types.
// Defines the narrowed context and event envelope for node-originated handlers.
import type { NodeRegistry } from "./node-registry.js";
import type { NodePresenceActivityUpdate } from "./node-registry.presence.js";
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
  authorizeNodeSystemRunEvent: (
    params: Omit<Parameters<NodeRegistry["authorizeSystemRunEventWithState"]>[0], "terminal"> & {
      event: "exec.started" | "exec.finished" | "exec.denied";
    },
  ) => boolean | NonNullable<ReturnType<NodeRegistry["authorizeSystemRunEventWithState"]>>;
  updateNodePresenceActivity?: (
    params: Omit<NodePresenceActivityUpdate, "observedAtMs">,
  ) => { lastActiveAtMs: number; presenceUpdatedAtMs: number } | null;
  clearNodePresenceActivity?: NodeRegistry["clearPresenceActivity"];
  updateNodeHostStats?: (
    params: Omit<Parameters<NodeRegistry["updateHostStats"]>[0], "observedAtMs">,
  ) => ReturnType<NodeRegistry["updateHostStats"]>;
  updateNodeDesktopAvailability?: NodeRegistry["updateDesktopAvailability"];
  logGateway: { warn: (msg: string) => void };
};

/** Raw event envelope received from connected node clients. */
export type NodeEvent = {
  event: string;
  payloadJSON?: string | null;
};
