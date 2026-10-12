import type { SessionBranch } from "../../api/types.ts";
import { scopedAgentParamsForSession, visibleSessionMatches } from "../../lib/sessions/index.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import type { ChatState } from "./chat-state-contract.ts";

const pendingBranchLoads = new WeakMap<
  ChatState,
  { matches: () => boolean; promise: Promise<void> }
>();

export function retireChatBranchRequests(state: ChatState): void {
  chatHistoryRequests(state).branchVersion += 1;
  pendingBranchLoads.delete(state);
}

export function invalidateChatBranches(state: ChatState): void {
  retireChatBranchRequests(state);
  // Keep the displayed menu while the next history refresh reconciles saved tips.
  state.chatBranchesConnectionEpoch = null;
}

/** Branches for the current pane; equivalence covers alias-canonicalization windows (#124020 class). */
export function displayedChatSessionBranches(
  state: Pick<ChatState, "chatBranches" | "chatBranchesSessionKey" | "sessionKey">,
): SessionBranch[] {
  return areUiSessionKeysEquivalent(state.chatBranchesSessionKey, state.sessionKey)
    ? (state.chatBranches ?? [])
    : [];
}

export async function loadChatBranches(state: ChatState): Promise<void> {
  const { sessions, client, sessionKey, connectionEpoch } = state;
  const listBranches = sessions?.listBranches;
  if (!listBranches || !client || !state.connected) {
    return;
  }
  const pending = pendingBranchLoads.get(state);
  if (pending?.matches()) {
    return pending.promise;
  }
  const requests = chatHistoryRequests(state);
  const version = ++requests.branchVersion;
  const agentParams = scopedAgentParamsForSession(state, sessionKey);
  const isCurrent = () =>
    requests.branchVersion === version &&
    state.client === client &&
    state.connected &&
    state.connectionEpoch === connectionEpoch &&
    visibleSessionMatches(state, sessionKey, agentParams.agentId);
  const promise = (async () => {
    try {
      const branches = await listBranches.call(sessions, sessionKey, agentParams);
      if (isCurrent()) {
        state.chatBranches = branches;
        state.chatBranchesSessionKey = sessionKey;
        state.chatBranchesConnectionEpoch = connectionEpoch;
      }
    } catch {
      // Leave the success receipt unset so the next history load retries transient failures.
    }
  })().finally(() => {
    if (requests.branchVersion === version) {
      pendingBranchLoads.delete(state);
      state.requestUpdate?.();
    }
  });
  pendingBranchLoads.set(state, {
    matches: () =>
      isCurrent() &&
      state.sessionKey === sessionKey &&
      scopedAgentParamsForSession(state, sessionKey).agentId === agentParams.agentId,
    promise,
  });
  return promise;
}
