import { t } from "../../i18n/index.ts";
import { registerChatFileReferencesEnglish } from "../../i18n/locales/en-chat-file-references.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { visibleSessionMatches } from "../../lib/sessions/navigation.ts";
import {
  isExpiredIncognitoSession,
  isInitialChatHistoryUnavailable,
  setChatError,
} from "./chat-history-state.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { getPendingChatPickerPatch } from "./chat-settings-patches.ts";
import { isChatBusy } from "./run-lifecycle.ts";

registerChatFileReferencesEnglish();

/** The chat transport has no object-identity namespace. Conversion is an explicit composer action. */
export function refuseUnsupportedFileReferenceSend(
  host: ChatHost,
  messageOverride?: string,
): boolean {
  if (messageOverride != null || !host.chatFileReferences?.length) {
    return false;
  }
  setChatError(host, t("chat.fileReferences.sendUnsupported"));
  return true;
}

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
    !item.fileReferences?.length &&
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
