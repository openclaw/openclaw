import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { DurableComposerDraftScope } from "../../lib/chat/composer-draft-store.runtime.ts";
import { readHumanMentions } from "../../lib/chat/human-mentions.ts";
import { outboxPayloadMatchesOwner } from "../../lib/chat/outbox-payload-store.runtime.ts";
import {
  rememberDraftRevision,
  readDraftRevisionState,
} from "../../lib/chat/outbox-store-draft-state.ts";
import {
  notifyStoredChatOutboxChanges,
  readStoredOutboxStore as readStore,
  resolvePendingComposerSessions,
  clearStoredComposerDraftInput,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  writeStoredOutboxStore as writeStore,
  type ChatComposerScope,
  type StoredChatOutboxScope,
} from "../../lib/chat/outbox-store.ts";
import {
  resolveUiConversationIdentity,
  hasUiSessionDefaults,
} from "../../lib/sessions/session-key.ts";
import { getSafeSessionStorage } from "../../local-storage.ts";
import { normalizeChatComposerDraft } from "./composer-draft.ts";
import {
  captureChatComposerOwner,
  isIncognitoComposerScope,
  type DurableChatComposerPersistenceState,
  type ChatComposerDraftSnapshot,
  type ChatComposerDraftRevisionState,
  type StoredChatComposerSnapshot,
} from "./composer-persistence-state.ts";
import { serializeQueueItemForScope } from "./composer-queue-serialization.ts";
import { captureDurableChatAttachments } from "./durable-composer-persistence.ts";

export function loadCapturedChatComposerState(
  state: ChatComposerScope,
  captured: StoredChatOutboxScope,
): {
  snapshot: StoredChatComposerSnapshot | null;
  revisions: ChatComposerDraftRevisionState;
} {
  const empty = { snapshot: null, revisions: { committed: 0, latestAttempt: 0 } };
  const storage = getSafeSessionStorage();
  if (!storage) {
    return empty;
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    const migrated = resolvePendingComposerSessions(store, state);
    if (migrated) {
      try {
        writeStore(storage, target, store);
      } catch {
        // Migration persistence is best-effort; readable drafts and outboxes remain usable.
      }
    }
    const scopeKey = storedChatOutboxScopeKey(captured);
    const session = store.sessions[scopeKey];
    if (
      session &&
      isIncognitoComposerScope(state, captured) &&
      clearStoredComposerDraftInput(session)
    ) {
      // Retire legacy unsent input, preserving submitted queue entries and the
      // revision fence used by live pane handoffs.
      try {
        writeStore(storage, target, store);
        notifyStoredChatOutboxChanges();
      } catch {
        // Even unavailable storage must not restore private unsent input.
      }
    }
    rememberDraftRevision(storage, target.key, scopeKey, session?.draftRevision);
    const revisions = readDraftRevisionState(storage, target.key, scopeKey, session?.draftRevision);
    const draft = normalizeChatComposerDraft(session?.draft ?? "");
    if (
      !session ||
      (!draft && !session.goalMode && !session.replyTarget && !session.queue?.length)
    ) {
      return { snapshot: null, revisions };
    }
    return {
      revisions,
      snapshot: {
        draft,
        ...(session.draftMentions ? { mentions: session.draftMentions } : {}),
        ...(session.goalMode ? { goalMode: session.goalMode } : {}),
        ...(session.replyTarget ? { replyTarget: { ...session.replyTarget } } : {}),
        queue: (session.queue ?? [])
          .filter((item) => outboxPayloadMatchesOwner(state, item))
          .map((item) => serializeQueueItemForScope(item, captured))
          .filter((item): item is ChatQueueItem => item !== null),
      },
    };
  } catch {
    return empty;
  }
}

export function captureChatComposerDraftSnapshot(
  state: DurableChatComposerPersistenceState,
  durableScope: DurableComposerDraftScope | null,
  draftRevision: number,
  expectedDraftRevision: number,
): ChatComposerDraftSnapshot {
  const scope = resolveUiConversationIdentity(state, state.sessionKey);
  const text = normalizeChatComposerDraft(state.chatMessage);
  const goalMode = state.chatGoalDraftMode ? { ...state.chatGoalDraftMode } : undefined;
  const replyTarget = state.chatReplyTarget ? { ...state.chatReplyTarget } : undefined;
  const mentions = readHumanMentions(state.chatMessage, state.chatMentions);
  const attachments = (state.chatAttachments ?? []).map((attachment) =>
    Object.assign(
      {},
      attachment,
      attachment.browserAnnotation
        ? { browserAnnotation: Object.assign({}, attachment.browserAnnotation) }
        : {},
      attachment.selectionAnnotation
        ? { selectionAnnotation: Object.assign({}, attachment.selectionAnnotation) }
        : {},
    ),
  );
  const durable = durableScope
    ? {
        scope: durableScope,
        expectedRevision: expectedDraftRevision,
        revision: draftRevision,
        text,
        ...(mentions ? { mentions } : {}),
        ...(goalMode ? { goalMode } : {}),
        ...(replyTarget ? { replyTarget } : {}),
        storedAttachments: captureDurableChatAttachments(attachments),
        writeId: `${draftRevision}:${Math.random().toString(36).slice(2)}`,
      }
    : undefined;
  return {
    owner: captureChatComposerOwner(state),
    scope,
    incognito: isIncognitoComposerScope(state, scope),
    awaitingDefaults: !hasUiSessionDefaults(state),
    sessionKey: state.sessionKey,
    chatMessage: text,
    ...(mentions ? { mentions } : {}),
    ...(goalMode ? { goalMode } : {}),
    ...(replyTarget ? { replyTarget: { ...replyTarget } } : {}),
    expectedDraftRevision,
    draftRevision,
    attachments,
    ...(durable ? { durable } : {}),
  };
}
