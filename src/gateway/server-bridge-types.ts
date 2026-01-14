import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { CliDeps } from "../cli/deps.js";
import type { HealthSummary } from "../commands/health.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { ChatRunEntry } from "./server-chat.js";
import type { DedupeEntry } from "./server-shared.js";

export type BridgeHandlersContext = {
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  bridgeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  bridgeSubscribe: (nodeId: string, sessionKey: string) => void;
  bridgeUnsubscribe: (nodeId: string, sessionKey: string) => void;
  broadcastVoiceWakeChanged: (triggers: string[]) => void;
  addChatRun: (sessionId: string, entry: ChatRunEntry) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatAbortedRuns: Map<string, number>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  dedupe: Map<string, DedupeEntry>;
  agentRunSeq: Map<string, number>;
  getHealthCache: () => HealthSummary | null;
  refreshHealthSnapshot: (opts?: { probe?: boolean }) => Promise<HealthSummary>;
  loadGatewayModelCatalog: () => Promise<ModelCatalogEntry[]>;
  logBridge: { warn: (msg: string) => void };
};

export type BridgeRequest = {
  id: string;
  method: string;
  paramsJSON?: string | null;
};

export type BridgeEvent = {
  event: string;
  payloadJSON?: string | null;
};

export type BridgeResponse =
  | { ok: true; payloadJSON?: string | null }
  | {
      ok: false;
      error: { code: string; message: string; details?: unknown };
    };

export type BridgeRequestParams = Record<string, unknown>;

export type BridgeMethodHandler = (
  ctx: BridgeHandlersContext,
  nodeId: string,
  method: string,
  params: BridgeRequestParams,
) => Promise<BridgeResponse | null>;
