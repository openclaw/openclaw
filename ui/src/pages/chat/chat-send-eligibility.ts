import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { visibleSessionMatches } from "../../lib/sessions/navigation.ts";
import {
  isExpiredIncognitoSession,
  isInitialChatHistoryUnavailable,
} from "./chat-history-state.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { getPendingChatPickerPatch } from "./chat-settings-patches.ts";
import { isChatBusy } from "./run-lifecycle.ts";

export function reconnectSafeQueuedSendState(
  host: Pick<ChatHost, "client" | "connected" | "gatewayWorkPaused">,
): "waiting-idle" | "waiting-reconnect" {
  return host.connected && host.client && !host.gatewayWorkPaused
    ? "waiting-idle"
    : "waiting-reconnect";
}

export function canSendVolatileQueueItem(
  host: ChatHost,
  item: ChatQueueItem,
  routingSessionKey = item.sessionKey ?? host.sessionKey,
): boolean {
  return (
    host.connected &&
    !host.gatewayWorkPaused &&
    Boolean(host.client) &&
    !host.chatLoading &&
    !isInitialChatHistoryUnavailable(host) &&
    !isExpiredIncognitoSession(host, routingSessionKey) &&
    !isChatBusy(host) &&
    !getPendingChatPickerPatch(host, routingSessionKey, item.agentId) &&
    visibleSessionMatches(host, routingSessionKey, item.agentId) &&
    host.chatQueue[0]?.id === item.id
  );
}

export async function waitForPendingChatSettings(
  host: ChatHost,
  sessionKey: string,
  initialPending: Promise<boolean>,
): Promise<boolean> {
  let pending = initialPending;
  while (await pending) {
    const nextPending = getPendingChatPickerPatch(host, sessionKey);
    if (!nextPending || nextPending === pending) {
      return true;
    }
    pending = nextPending;
  }
  return false;
}

export async function waitForSubmittedRoute(host: ChatHost, sessionKey: string): Promise<boolean> {
  const pending = getPendingChatPickerPatch(host, sessionKey);
  if (pending && !(await waitForPendingChatSettings(host, sessionKey, pending))) {
    return false;
  }
  return host.sessionKey === sessionKey;
}
