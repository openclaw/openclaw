// Gateway node event types.
// Defines the narrowed context and event envelope for node-originated handlers.
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { HealthSummary } from "../commands/health.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
<<<<<<< HEAD
import type { ChatAbortMarker, ChatRunEntry, ChatRunRegistration } from "./server-chat.js";
=======
import type { ChatRunEntry } from "./server-chat.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import type { DedupeEntry } from "./server-shared.js";

/** Runtime context available to node event handlers. */
export type NodeEventContext = {
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  nodeSubscribe: (nodeId: string, sessionKey: string) => void;
  nodeUnsubscribe: (nodeId: string, sessionKey: string) => void;
  broadcastVoiceWakeChanged: (triggers: string[]) => void;
<<<<<<< HEAD
  addChatRun: (sessionId: string, entry: ChatRunRegistration) => void;
=======
  addChatRun: (sessionId: string, entry: ChatRunEntry) => void;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
<<<<<<< HEAD
  chatAbortedRuns: Map<string, ChatAbortMarker>;
=======
  chatAbortedRuns: Map<string, number>;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  dedupe: Map<string, DedupeEntry>;
  agentRunSeq: Map<string, number>;
  getHealthCache: () => HealthSummary | null;
  refreshHealthSnapshot: (opts?: {
    probe?: boolean;
    includeSensitive?: boolean;
  }) => Promise<HealthSummary>;
  loadGatewayModelCatalog: () => Promise<ModelCatalogEntry[]>;
  authorizeNodeSystemRunEvent: (params: {
    nodeId: string;
    connId?: string;
    runId?: string;
    sessionKey: string;
    terminal: boolean;
  }) => boolean;
  logGateway: { warn: (msg: string) => void };
};

/** Raw event envelope received from connected node clients. */
export type NodeEvent = {
  event: string;
  payloadJSON?: string | null;
};
