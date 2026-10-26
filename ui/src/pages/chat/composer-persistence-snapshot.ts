import type { DurableComposerDraftScope } from "../../lib/chat/composer-draft-store.runtime.ts";
import { readHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  resolveUiConversationIdentity,
  hasUiSessionDefaults,
} from "../../lib/sessions/session-key.ts";
import { normalizeChatComposerDraft } from "./composer-draft.ts";
import {
  captureChatComposerOwner,
  isChatComposerOwnerCurrent,
  isIncognitoComposerScope,
  type DurableChatComposerPersistenceState,
  type ChatComposerDraftSnapshot,
} from "./composer-persistence-state.ts";
import { captureDurableChatAttachments } from "./durable-composer-persistence.ts";

export function captureChatComposerDraftSnapshot(
  state: DurableChatComposerPersistenceState,
  candidateDurableScope: DurableComposerDraftScope | null,
  draftRevision: number,
  expectedDraftRevision: number,
  previous?: ChatComposerDraftSnapshot | null,
): ChatComposerDraftSnapshot {
  // The client is mutable across hello: capture retained presentation provenance
  // before an old pane can stamp its input with the replacement account.
  const replaced =
    previous?.owner.recoveryScope &&
    !isChatComposerOwnerCurrent({ ...state, connected: false }, previous.owner);
  const durableScope = replaced ? (previous.durable?.scope ?? null) : candidateDurableScope;
  const scope = resolveUiConversationIdentity(state, state.sessionKey);
  const text = normalizeChatComposerDraft(state.chatMessage);
  const goalMode = state.chatGoalDraftMode ?? undefined;
  const replyTarget = state.chatReplyTarget ?? undefined;
  const mentions = readHumanMentions(state.chatMessage, state.chatMentions);
  const attachments = state.chatAttachments ?? [];
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
    owner: replaced ? previous.owner : captureChatComposerOwner(state),
    scope,
    incognito: isIncognitoComposerScope(state, scope),
    awaitingDefaults: !hasUiSessionDefaults(state),
    sessionKey: state.sessionKey,
    chatMessage: text,
    ...(mentions ? { mentions } : {}),
    ...(goalMode ? { goalMode } : {}),
    ...(replyTarget ? { replyTarget } : {}),
    expectedDraftRevision,
    draftRevision,
    attachments,
    ...(durable ? { durable } : {}),
  };
}
