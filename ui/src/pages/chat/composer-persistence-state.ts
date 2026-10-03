import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import type {
  ChatAttachment,
  ChatComposerDraftRetry,
  ChatGoalDraftMode,
  ChatReplyTarget,
  ChatQueueItem,
  HumanMention,
} from "../../lib/chat/chat-types.ts";
import { observeOutboxRecoveryOwner } from "../../lib/chat/outbox-payload-store.runtime.ts";
import type { readDraftRevisionState } from "../../lib/chat/outbox-store-draft-state.ts";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store-scope.ts";
import {
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  storageTargetForComposer,
  type ChatComposerScope,
} from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import type { DurableChatComposerSnapshot } from "./durable-composer-persistence.ts";

export type ChatComposerPersistStatus = "persisted" | "conflict" | "storage-failed";

export type ChatComposerPersistResult =
  | { status: "persisted" }
  | { status: "conflict" }
  | ({ status: "storage-failed" } & ChatComposerDraftRetry);

export type StoredChatQueueReplacement = {
  id: string;
  expected: ChatQueueItem;
};

export type ChatComposerDraftRevisionState = ReturnType<typeof readDraftRevisionState>;

export type StoredChatComposerSnapshot = {
  draft: string;
  mentions?: readonly HumanMention[];
  goalMode?: ChatGoalDraftMode;
  replyTarget?: ChatReplyTarget;
  queue: ChatQueueItem[];
};

export type RestoreOptions = {
  preserveCurrent?: boolean;
  sessionKey?: string;
};

export type ChatComposerPersistOptions = {
  agentId?: string;
  draft?: string;
  mentions?: readonly HumanMention[];
  goalMode?: ChatGoalDraftMode | null;
  replyTarget?: ChatReplyTarget | null;
  draftRevision?: number;
  expectedDraftRevision?: number;
};

export type ChatComposerPersistenceState = ChatComposerScope & {
  sessionKey: string;
  chatMessage: string;
  chatMentions?: readonly HumanMention[];
  chatGoalDraftMode?: ChatGoalDraftMode | null;
  chatReplyTarget?: ChatReplyTarget | null;
  chatAttachments?: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  lastError?: string | null;
  chatError?: string | null;
  requestUpdate?: () => void;
};

export type DurableChatComposerPersistenceState = ChatComposerPersistenceState & {
  selectedChatSessionIncognito: boolean;
};

export type ChatComposerDraftSnapshot = {
  owner: ReturnType<typeof captureChatComposerOwner>;
  scope: StoredChatOutboxScope;
  incognito: boolean;
  awaitingDefaults: boolean;
  sessionKey: string;
  chatMessage: string;
  mentions?: readonly HumanMention[];
  goalMode?: ChatGoalDraftMode;
  replyTarget?: ChatReplyTarget;
  expectedDraftRevision: number;
  draftRevision: number;
  attachments: ChatAttachment[];
  durable?: DurableChatComposerSnapshot;
};

export function captureChatComposerOwner(state: ChatComposerScope) {
  return {
    gatewayOwner: storageTargetForGateway(state.settings?.gatewayUrl).gatewayOwner,
    recoveryScope: observeOutboxRecoveryOwner(state) ?? "",
    client: state.client,
  };
}

export function isChatComposerOwnerCurrent(
  state: ChatComposerScope,
  owner: ReturnType<typeof captureChatComposerOwner>,
): boolean {
  return (
    owner.gatewayOwner === storageTargetForGateway(state.settings?.gatewayUrl).gatewayOwner &&
    owner.recoveryScope === (observeOutboxRecoveryOwner(state) ?? "") &&
    (owner.client === state.client || state.client?.recoveryScopeReady === true)
  );
}

export function isIncognitoComposerScope(
  state: ChatComposerScope & { sessionKey?: string },
  scope: StoredChatOutboxScope,
): boolean {
  // Keys classify private sessions before roster metadata arrives. A selected
  // session's metadata must never classify a delayed write to another scope.
  return (
    isIncognitoSessionKey(scope.sessionKey) ||
    Boolean(
      state.selectedChatSessionIncognito &&
      state.sessionKey &&
      storedChatOutboxScopeKey(resolveUiConversationIdentity(state, state.sessionKey)) ===
        storedChatOutboxScopeKey(scope),
    )
  );
}

export function resolveChatComposerDurableScope(
  state: DurableChatComposerPersistenceState,
  scope: StoredChatOutboxScope = resolveUiConversationIdentity(state, state.sessionKey),
) {
  const recoveryScope = observeOutboxRecoveryOwner(state);
  if (!recoveryScope) {
    return null;
  }
  return {
    gatewayOwner: storageTargetForComposer(state).gatewayOwner,
    recoveryScope,
    scopeKey: `chat:v3:${storedChatOutboxScopeKey(scope)}`,
  };
}
