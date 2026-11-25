import { normalizeChatFollowUpModeOverride } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import type { ControlUiFollowUpMode } from "../../lib/chat/follow-up-mode.ts";
import {
  outboxPayloadTab,
  outboxStorageScope,
} from "../../lib/chat/outbox-payload-store.runtime.ts";
import {
  storedChatOutboxScopeKey,
  type StoredChatOutboxScope,
} from "../../lib/chat/outbox-store-scope.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { getSafeLocalStorage, getSafeSessionStorage } from "../../local-storage.ts";
import { setChatError } from "./chat-history-state.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { isIncognitoComposerScope } from "./composer-persistence-state.ts";

export const CHAT_QUEUE_PREFERENCE_PREFIX = "openclaw.control.collectQueuedChat.v1:";

export function chatQueuePreferenceTarget(host: ChatHost, scope: StoredChatOutboxScope) {
  const sender = resolveCurrentUserIdentity(
    host.hello,
    host.client?.instanceId,
    host.selfUser,
  )?.identity;
  const storageScope = outboxStorageScope(host);
  if (
    !host.connected ||
    !host.currentSessionId ||
    !storageScope ||
    sender?.type !== "profile" ||
    isIncognitoComposerScope(host, scope) ||
    !globalThis.navigator?.locks ||
    !getSafeSessionStorage() ||
    !getSafeLocalStorage()
  ) {
    return undefined;
  }
  const client = JSON.stringify([
    storageScope,
    sender.id,
    storedChatOutboxScopeKey(scope),
    host.currentSessionId,
  ]);
  return { key: CHAT_QUEUE_PREFERENCE_PREFIX + client, client };
}

export function chatQueuePreferenceEnabled(key: string): boolean {
  try {
    return getSafeLocalStorage()?.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function setChatQueuePreference(key: string, enabled: boolean): boolean {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return false;
    }
    if (enabled) {
      storage.setItem(key, "1");
    } else {
      storage.removeItem(key);
    }
    return chatQueuePreferenceEnabled(key) === enabled;
  } catch {
    return false;
  }
}

export function readCollectClient(
  host: ChatHost,
  scope: StoredChatOutboxScope,
): string | undefined {
  const target = chatQueuePreferenceTarget(host, scope);
  return target && chatQueuePreferenceEnabled(target.key) ? target.client : undefined;
}

export function prepareQueuedCollection(
  host: ChatHost,
  scope: StoredChatOutboxScope,
  explicitMode: ControlUiFollowUpMode | undefined,
) {
  if (explicitMode && explicitMode !== "queue") {
    return undefined;
  }
  const collectClient = readCollectClient(host, scope);
  if (!collectClient) {
    return undefined;
  }
  return outboxPayloadTab()
    .then((collectTabId) => ({ collectTabId, collectClient }))
    .catch(() => undefined);
}

export function resolveChatSubmitFollowUpMode(
  host: ChatHost,
  explicitMode: ControlUiFollowUpMode | undefined,
  forceQueue: boolean,
  editedRow?: { queueMode?: ControlUiFollowUpMode },
) {
  if (forceQueue) {
    return "queue";
  }
  // Editing preserves the original delivery choice, not the current composer default.
  return editedRow
    ? (editedRow.queueMode ?? "queue")
    : (explicitMode ??
        host.chatFollowUpMode ??
        normalizeChatFollowUpModeOverride(host.settings.chatFollowUpMode));
}

export function chatQueuePreferenceToggle(
  host: ChatHost,
  isCurrent: () => boolean,
  changed: () => void,
) {
  const readTarget = () =>
    chatQueuePreferenceTarget(host, resolveUiConversationIdentity(host, host.sessionKey));
  const target = readTarget();
  if (!target) {
    return undefined;
  }
  return {
    value: "collect-queued-chat",
    label: t("chat.composer.collectQueued"),
    title: t("chat.composer.collectQueuedHelp"),
    checked: chatQueuePreferenceEnabled(target.key),
    disabled: false,
    onChange(enabled: boolean) {
      if (!isCurrent() || readTarget()?.key !== target.key) {
        return;
      }
      if (!setChatQueuePreference(target.key, enabled)) {
        setChatError(host, t("chat.composer.collectQueuedSaveError"));
      }
      changed();
    },
  };
}
