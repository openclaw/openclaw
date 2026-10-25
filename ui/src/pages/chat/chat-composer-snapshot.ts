import type { AgentsListResult, ModelCatalogResult } from "../../api/types.ts";
import { resolveChatModelSelectState } from "../../lib/chat/model-select-state.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import { cacheChatSessionSnapshot, readChatSessionSnapshot } from "./session-message-cache.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";

export function cacheChatComposerSnapshot(host: ChatPageHost, result: ModelCatalogResult): void {
  if (!host.connected || !host.client?.recoveryScopeReady || result.refreshFailed) {
    return;
  }
  const target = { sessionKey: host.sessionKey };
  const snapshotKey = resolveChatSnapshotKey(host, target);
  const client = host.client;
  const epoch = host.connectionEpoch;
  const persist = () => {
    if (
      !host.connected ||
      !client.recoveryScopeReady ||
      client.offlineRecoveryRetired ||
      host.client !== client ||
      host.connectionEpoch !== epoch ||
      host.sessionKey !== target.sessionKey ||
      resolveChatSnapshotKey(host, target) !== snapshotKey ||
      host.chatModelCatalog !== result.models
    ) {
      return;
    }
    const session = selectedChatSessionRow(host);
    // A catalog default cannot replace the selected session's unresolved model.
    if (!session) {
      return;
    }
    const agents: AgentsListResult | null = host.agentsList;
    const selection = resolveChatModelSelectState({
      activeSession: session,
      agentDefaultModel: agents?.agents.find((agent) => agent.id === resolveChatAgentId(host))
        ?.model?.primary,
      modelOverrides: host.sessions.state.modelOverrides,
      sessionKey: host.sessionKey,
      sessionsResult: host.sessionsResult,
      chatModelCatalog: result.models,
      modelSelectionPolicy: result.modelSelectionPolicy,
    });
    const model = selection.currentOverride || selection.defaultModel;
    const entry = result.models.find(
      (candidate) =>
        `${candidate.provider}/${candidate.id}` === model ||
        (candidate.id === model &&
          (!session?.modelProvider || session.modelProvider === candidate.provider)),
    );
    const previous = readChatSessionSnapshot(host.chatMessagesBySession, host, target);
    const composer = entry ? { id: entry.id, provider: entry.provider, name: entry.name } : null;
    if (JSON.stringify(previous?.composer) === JSON.stringify(composer)) {
      return;
    }
    cacheChatSessionSnapshot(host.chatMessagesBySession, host, target, {
      ...(previous ?? { messages: [], pagination: { hasMore: false }, sessionId: null }),
      composer,
    });
  };
  // Share transcript hydration; an early catalog must not replace its saved rows.
  const hydration = chatHistoryRequests(host).initialSnapshotHydration;
  if (hydration) {
    void hydration.promise.then(persist);
  } else {
    persist();
  }
}
