import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import type { ChatAbortControllerEntry, RestartRecoveryCandidate } from "./chat-abort.js";
import type { GatewayBroadcastFn, GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type {
  ChatRunState,
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import type { ToolEventRecipientRegistry } from "./server-chat-tool-recipients.js";
import type { SessionRowProjection } from "./session-row-projection.js";

export type GatewayEventSubscriptionParams = {
  scheduler: GatewayScheduler;
  signal: AbortSignal;
  log: SubsystemLogger;
  broadcast: GatewayBroadcastFn;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  nodeHasSessionSubscribers: (sessionKey: string) => boolean;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  sessionMessageSubscribers: SessionMessageSubscriberRegistry;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  restartRecoveryCandidates: Map<string, RestartRecoveryCandidate>;
  refreshConnectedUserProfiles: () => void;
  getSessionRowProjection?: () => SessionRowProjection | undefined;
};
