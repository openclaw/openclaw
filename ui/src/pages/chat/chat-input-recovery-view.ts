import { dismissChatInputRecoveryKey } from "../../app/settings.ts";
import { resolveChatAgentId } from "./chat-agent-id.ts";
import {
  discardChatRecoveryInput,
  getChatInputRecovery,
  sendChatRecoveryInput,
} from "./chat-input-recovery-actions.ts";
import { getChatPendingInputs, loadChatPendingInputs } from "./chat-pending-inputs.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatQueueRecovery } from "./components/chat-queue-recovery.types.ts";

/** Presentation/action adapter only: the real outbox remains a separate input. */
export function createChatInputRecoveryQueueProps(
  host: ChatPageHost,
  canSend: boolean,
): ChatQueueRecovery | undefined {
  const gatewayUrl = host.settings.gatewayUrl;
  const incognito = host.selectedChatSessionIncognito;
  const keys = new Set(incognito ? [] : host.settings.chatInputRecoveryDismissed);
  host.chatInputRecoveryDismissals = {
    has: (key) => keys.has(key),
    add: (key) => {
      keys.add(key);
      return incognito || dismissChatInputRecoveryKey(gatewayUrl, key);
    },
  };
  const view = getChatPendingInputs(host);
  if (!view || view.client !== host.client) {
    return undefined;
  }
  const client = host.client;
  const epoch = host.connectionEpoch;
  const sessionKey = host.sessionKey;
  const sessionId = host.currentSessionId;
  const agentId = resolveChatAgentId(host);
  const current = () =>
    host.client === client &&
    host.connectionEpoch === epoch &&
    host.sessionKey === sessionKey &&
    host.currentSessionId === sessionId &&
    resolveChatAgentId(host) === agentId &&
    host.settings.gatewayUrl === gatewayUrl;
  const recovery = getChatInputRecovery(host);
  if (
    !recovery.items.length &&
    view.before === undefined &&
    view.page.nextBefore === undefined &&
    !recovery.error &&
    !view.error
  ) {
    return undefined;
  }
  return {
    ...recovery,
    error: recovery.error ?? view.error,
    onSend:
      canSend && host.connected && view.connectionEpoch === epoch
        ? (id) => {
            if (current()) {
              void sendChatRecoveryInput(host, id);
            }
          }
        : undefined,
    onDiscard: (id) => {
      if (current()) {
        discardChatRecoveryInput(host, id);
      }
    },
    paging: {
      loading: view.loading,
      onEarlier:
        view.page.nextBefore === undefined || !host.connected
          ? undefined
          : () => {
              if (current()) {
                void loadChatPendingInputs(host, view.page.nextBefore);
              }
            },
      onLatest:
        view.before === undefined || !host.connected
          ? undefined
          : () => {
              if (current()) {
                void loadChatPendingInputs(host);
              }
            },
    },
  };
}
