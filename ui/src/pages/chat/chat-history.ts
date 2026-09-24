import type { ChatEvent } from "../../../../packages/gateway-protocol/src/schema/logs-chat.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import {
  areUiSessionKeysEquivalent,
  isUiSelectedGlobalSessionKey,
  normalizeAgentId,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import { loadChatBranches } from "./chat-history-branches.ts";
import { hydrateChatHistory } from "./chat-history-hydration.ts";
import { CHAT_HISTORY_REQUEST_LIMIT } from "./chat-history-request.ts";
import type { ObservedChatHistoryResult } from "./chat-history-snapshot.ts";
import { historySessionId } from "./chat-history-snapshot.ts";
import {
  chatHistoryRequests,
  getChatHistoryLoadState,
  setChatHistoryLoad,
  waitForInitialChatSnapshot,
} from "./chat-history-state.ts";
import { readChatInputRunIds } from "./chat-pending-inputs.ts";
import type { ChatRunStartupPhase } from "./chat-run-startup.ts";
import type { ChatHistoryHost, ChatState } from "./chat-state-contract.ts";
import { readChatSessionSnapshot } from "./session-message-cache.ts";

type LoadChatHistoryOptions = {
  deferBranches?: boolean;
  supersedeInFlight?: boolean;
  startup?: boolean;
};

type ChatErrorDetail = Extract<ChatEvent, { state: "error" }>["errorDetail"];

export async function loadChatHistory(
  state: ChatHistoryHost,
  opts: LoadChatHistoryOptions = {},
): Promise<ObservedChatHistoryResult | undefined> {
  let sessionKey = state.sessionKey;
  const requestAgentId = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const startup = opts.startup === true;
  const creationPending =
    state.chatSubmissions?.creation?.sessionKey === sessionKey ||
    state.hasPendingInitialTurn?.(sessionKey);
  const requests = chatHistoryRequests(state);
  if (!state.client || !state.connected) {
    setChatHistoryLoad(state, { phase: "pending-connection", sessionKey, requestAgentId, startup });
    state.chatLoading = true;
    state.requestUpdate?.();
    return undefined;
  }
  const method = startup ? "chat.startup" : "chat.history";
  const client = state.client;
  const sessions = state.sessions;
  const connectionEpoch = state.connectionEpoch;
  const hydration = startup ? waitForInitialChatSnapshot(state) : undefined;
  if (hydration) {
    const version = requests.historyVersion;
    state.chatLoading = true;
    state.requestUpdate?.();
    const current = await hydration;
    if (
      !current ||
      !state.connected ||
      state.client !== client ||
      state.sessions !== sessions ||
      state.connectionEpoch !== connectionEpoch ||
      !areUiSessionKeysEquivalent(state.sessionKey, sessionKey) ||
      (isUiSelectedGlobalSessionKey(state, sessionKey) &&
        resolveUiSelectedSessionAgentId(state) !== requestAgentId)
    ) {
      return undefined;
    }
    sessionKey = state.sessionKey;
    if (requests.historyVersion !== version) {
      const active = requests.historyLoad;
      if (active.phase === "idle") {
        return undefined;
      }
      if (
        active.phase === "in-flight" &&
        opts.supersedeInFlight !== true &&
        active.startup &&
        active.client === client &&
        active.sessions === sessions &&
        active.connectionEpoch === connectionEpoch &&
        active.sessionKey === sessionKey &&
        active.requestAgentId === requestAgentId
      ) {
        return active.promise;
      }
    }
  }
  const deltaCursor = state.chatMessagesBySession
    ? readChatSessionSnapshot(state.chatMessagesBySession, state, {
        sessionKey,
        agentId: requestAgentId,
      })?.deltaCursor
    : undefined;
  const requestModeKey = deltaCursor === undefined ? "page" : `cursor:${deltaCursor}`;
  const inputRunIds = readChatInputRunIds(state);
  const requestKeyPrefix = JSON.stringify([
    connectionEpoch,
    method,
    sessionKey,
    requestAgentId ?? "",
    CHAT_HISTORY_REQUEST_LIMIT,
    inputRunIds,
  ]);
  const requestKey = `${requestKeyPrefix}${requestModeKey}`;
  const inFlight = requests.historyLoad;
  // Retire stale publication immediately, but let its raw read settle before
  // issuing one fresh snapshot for all changes observed while it was pending.
  if (
    inFlight.phase === "in-flight" &&
    inFlight.sessionKey === sessionKey &&
    inFlight.requestAgentId === requestAgentId &&
    inFlight.client === client &&
    inFlight.sessions === sessions &&
    inFlight.connectionEpoch === connectionEpoch
  ) {
    if (inFlight.refresh) {
      inFlight.refresh.startup ||= startup;
      inFlight.refresh.deferBranches &&= opts.deferBranches === true;
      return inFlight.refresh.promise;
    }
    if (opts.supersedeInFlight !== true && inFlight.key === requestKey) {
      return inFlight.promise;
    }
    const version = ++requests.historyVersion;
    const refresh = {
      startup: startup || inFlight.startup,
      deferBranches: opts.deferBranches === true,
      promise: Promise.resolve<ObservedChatHistoryResult | undefined>(undefined),
    };
    refresh.promise = inFlight.promise.then(() => {
      if (
        requests.historyVersion !== version ||
        !state.connected ||
        state.client !== client ||
        state.sessions !== sessions ||
        state.connectionEpoch !== connectionEpoch ||
        state.sessionKey !== sessionKey ||
        (isUiSelectedGlobalSessionKey(state, sessionKey) &&
          resolveUiSelectedSessionAgentId(state) !== requestAgentId)
      ) {
        return undefined;
      }
      return loadChatHistory(state, refresh);
    });
    inFlight.refresh = refresh;
    return refresh.promise;
  }
  const promise = hydrateChatHistory(
    state,
    client,
    connectionEpoch,
    sessions,
    sessionKey,
    requestAgentId,
    method,
    deltaCursor,
    inputRunIds,
    requestKeyPrefix,
  ).then((result) => {
    const current = requests.historyLoad;
    if (current.phase === "in-flight" && current.promise === promise) {
      if (result) {
        // Appends can invalidate branch tips while this coalesced history read is pending.
        // Check freshness on settlement so that invalidation is not lost to its early return.
        if (
          opts.deferBranches !== true &&
          (!areUiSessionKeysEquivalent(state.chatBranchesSessionKey, sessionKey) ||
            state.chatBranchesConnectionEpoch !== connectionEpoch)
        ) {
          void loadChatBranches(state);
        }
        setChatHistoryLoad(state, {
          phase: "committed",
          sessions,
          client,
          connectionEpoch,
          sessionKey,
          requestAgentId,
          sessionInfo: result.sessionInfo,
          // A read begun during creation cannot prove that its provisional key expired.
          sessionId: historySessionId(result) ?? (creationPending ? undefined : null),
        });
      } else if (
        state.sessionKey === sessionKey &&
        (!isUiSelectedGlobalSessionKey(state, sessionKey) ||
          resolveUiSelectedSessionAgentId(state) === requestAgentId) &&
        (!state.connected ||
          current.client !== state.client ||
          current.sessions !== state.sessions ||
          current.connectionEpoch !== state.connectionEpoch)
      ) {
        setChatHistoryLoad(state, {
          phase: "pending-connection",
          sessionKey,
          requestAgentId,
          startup,
        });
        state.chatLoading = true;
      } else {
        setChatHistoryLoad(state, { phase: "idle" });
        state.chatLoading = false;
      }
      state.requestUpdate?.();
    }
    return result;
  });
  setChatHistoryLoad(state, {
    phase: "in-flight",
    sessions,
    client,
    connectionEpoch,
    key: requestKey,
    promise,
    sessionKey,
    requestAgentId,
    startup,
  });
  return promise;
}

export function resumePendingChatHistoryLoad(
  state: ChatHistoryHost,
): Promise<ObservedChatHistoryResult | undefined> | undefined {
  const load = getChatHistoryLoadState(state);
  if (load.phase === "pending-connection" || (load.phase === "failed" && load.retryable)) {
    return loadChatHistory(state, { startup: load.startup, deferBranches: true });
  }
  return undefined;
}

export function applyChatAgentsList(
  state: ChatState,
  agentsList: AgentsListResult | undefined,
  client: GatewayBrowserClient,
) {
  if (!agentsList || state.client !== client || !state.connected) {
    return;
  }
  state.agentsList = agentsList;
  state.agentsError = null;
  const selectedId =
    typeof state.agentsSelectedId === "string" && state.agentsSelectedId.trim()
      ? normalizeAgentId(state.agentsSelectedId)
      : undefined;
  if (selectedId && agentsList.agents.some((entry) => normalizeAgentId(entry.id) === selectedId)) {
    return;
  }
  state.agentsSelectedId =
    typeof agentsList.defaultId === "string" && agentsList.defaultId.trim()
      ? agentsList.defaultId
      : (agentsList.agents[0]?.id ?? null);
}

export type ChatEventPayload = {
  runId?: string;
  seq?: number;
  sessionKey: string;
  agentId?: string;
  state: "status" | "delta" | "final" | "aborted" | "error";
  phase?: ChatRunStartupPhase;
  retry?: NonNullable<Extract<ChatEvent, { state: "status" }>["retry"]>;
  message?: unknown;
  deltaText?: string;
  replace?: boolean;
  errorMessage?: string;
  errorKind?: Extract<ChatEvent, { state: "error" }>["errorKind"];
  errorDetail?: ChatErrorDetail;
  stopReason?: string;
  yielded?: true;
};
