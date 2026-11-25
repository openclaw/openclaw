import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { readHumanMentions } from "../../lib/chat/human-mentions.ts";
import { outboxPayloadMatchesOwner } from "../../lib/chat/outbox-payload-store.runtime.ts";
import {
  captureDraftReplacement,
  nextDraftRevision,
  rememberDraftAttempt,
  rememberDraftEdit,
  rememberDraftRevision,
  readDraftRevisionState,
} from "../../lib/chat/outbox-store-draft-state.ts";
import {
  storedChatOutboxScopeKey,
  type StoredChatOutboxScope,
} from "../../lib/chat/outbox-store-scope.ts";
import {
  captureChatOutboxAdmission,
  clearStoredComposerDraftInput,
  notifyDraftPresence,
  notifyStoredChatOutboxChanges,
  readStoredOutboxStore as readStore,
  resolvePendingComposerSessions,
  storageTargetForComposer,
  writeStoredOutboxStore as writeStore,
  type ChatComposerScope,
} from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { getSafeSessionStorage } from "../../local-storage.ts";
import { normalizeChatComposerDraft } from "./composer-draft.ts";
import {
  captureChatComposerOwner,
  isChatComposerOwnerCurrent,
  isIncognitoComposerScope,
  type ChatComposerPersistenceState,
  type ChatComposerPersistOptions,
  type ChatComposerPersistStatus,
  type ChatComposerDraftRevisionState,
  type StoredChatComposerSnapshot,
} from "./composer-persistence-state.ts";
import { serializeQueueItemForScope } from "./composer-queue-persistence.ts";

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
    const target = storageTargetForComposer(state);
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
        ...(session.replyTarget ? { replyTarget: session.replyTarget } : {}),
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

export function markChatComposerEdit(
  state: ChatComposerPersistenceState,
  draftRevision?: number,
): void {
  const scope = resolveUiConversationIdentity(state, state.sessionKey);
  const revision =
    draftRevision ??
    nextDraftRevision(loadCapturedChatComposerState(state, scope).revisions.latestAttempt);
  rememberDraftEdit(
    getSafeSessionStorage() ?? state,
    storageTargetForComposer(state).key,
    storedChatOutboxScopeKey(scope),
    revision,
  );
}

export function captureChatComposerReplacement(
  state: ChatComposerPersistenceState,
  sessionKey: string,
  agentId?: string,
): () => boolean {
  const scope = resolveUiConversationIdentity(state, sessionKey, agentId);
  const { revisions } = loadCapturedChatComposerState(state, scope);
  // Without browser storage, independent live composers have no shared draft
  // to overwrite; the same owner ledger still fences that pane's replacements.
  return captureDraftReplacement(
    getSafeSessionStorage() ?? state,
    storageTargetForComposer(state).key,
    storedChatOutboxScopeKey(scope),
    revisions.latestAttempt,
  );
}

export function loadChatComposerState(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
) {
  return loadCapturedChatComposerState(
    state,
    resolveUiConversationIdentity(state, sessionKey, agentIdOverride),
  );
}

export function persistCapturedChatComposerStateResult(
  state: ChatComposerPersistenceState,
  captured: Pick<ReturnType<typeof captureChatOutboxAdmission>, "scope" | "awaitingDefaults"> & {
    incognito?: boolean;
  },
  options: ChatComposerPersistOptions = {},
): ChatComposerPersistStatus {
  const storage = getSafeSessionStorage();
  if (!storage || !captured.scope.sessionKey.trim()) {
    return "storage-failed";
  }
  try {
    const owner = captureChatComposerOwner(state);
    const target = storageTargetForComposer(state);
    const store = readStore(storage, target);
    const storeSessionKey = storedChatOutboxScopeKey(captured.scope);
    const session = store.sessions[storeSessionKey] ?? null;
    const incognito = captured.incognito || isIncognitoComposerScope(state, captured.scope);
    const draft = incognito
      ? ""
      : normalizeChatComposerDraft(
          Object.hasOwn(options, "draft") ? (options.draft ?? "") : state.chatMessage,
        );
    const goalMode = incognito
      ? null
      : Object.hasOwn(options, "goalMode")
        ? options.goalMode
        : state.chatGoalDraftMode;
    const replyTarget = incognito
      ? null
      : Object.hasOwn(options, "replyTarget")
        ? options.replyTarget
        : state.chatReplyTarget;
    const mentions = readHumanMentions(
      draft,
      Object.hasOwn(options, "mentions") ? options.mentions : state.chatMentions,
    );
    const matchesDraftMetadata = (saved: typeof session) =>
      JSON.stringify(saved?.draftMentions ?? []) === JSON.stringify(mentions ?? []) &&
      JSON.stringify(saved?.goalMode ?? null) === JSON.stringify(goalMode ?? null) &&
      JSON.stringify(saved?.replyTarget ?? null) === JSON.stringify(replyTarget ?? null);
    const storedDraftRevision = session?.draftRevision;
    rememberDraftRevision(storage, target.key, storeSessionKey, storedDraftRevision);
    // Draft-only rows are bounded and may evict a clear tombstone. Retain the
    // seen revision while this tab is alive so an older failed write cannot
    // treat an evicted scope as revision zero and resurrect stale input.
    const { committed: committedDraftRevision, latestAttempt: newestDraftAttempt } =
      readDraftRevisionState(storage, target.key, storeSessionKey, storedDraftRevision);
    const draftRevision = options.draftRevision ?? nextDraftRevision(newestDraftAttempt);
    if (!Number.isSafeInteger(draftRevision) || draftRevision <= 0) {
      return "conflict";
    }
    const storedDraft = normalizeChatComposerDraft(session?.draft ?? "");
    // Draft interpretation shares the text revision; a retry cannot turn an objective into a command.
    const sameDraft = storedDraft === draft && matchesDraftMetadata(session);
    const expectedDraftRevision = options.expectedDraftRevision;
    const committedMatchesExpected =
      expectedDraftRevision === undefined ||
      committedDraftRevision === expectedDraftRevision ||
      (storedDraftRevision === draftRevision && sameDraft);
    // Reserve every accepted attempt before touching storage. A newer failed
    // edit or clear must fence out older pane fallbacks when capacity recovers.
    if (
      !committedMatchesExpected ||
      draftRevision < newestDraftAttempt ||
      (storedDraftRevision === draftRevision && !sameDraft)
    ) {
      return "conflict";
    }
    rememberDraftAttempt(storage, target.key, storeSessionKey, draftRevision);
    store.sessions[storeSessionKey] = {
      ...(captured.awaitingDefaults ? { awaitingDefaults: true as const } : {}),
      ...(draft ? { draft } : {}),
      ...(mentions ? { draftMentions: mentions } : {}),
      ...(goalMode ? { goalMode } : {}),
      ...(replyTarget ? { replyTarget: { ...replyTarget } } : {}),
      draftRevision,
      ...(session?.queue?.length ? { queue: session.queue } : {}),
      updatedAt: Date.now(),
    };
    writeStore(storage, target, store);
    const persisted = readStore(storage, target).sessions[storeSessionKey];
    if (
      persisted?.draftRevision === draftRevision &&
      (persisted.draft ?? "") === draft &&
      matchesDraftMetadata(persisted)
    ) {
      // Notify only on presence transitions: sidebar draft indicators consume
      // presence, and content-only notifies would let projection subscribers
      // re-persist a stale pane over a newer draft (route-fallback invariant).
      notifyDraftPresence({ ...session, draft: storedDraft }, { draft, goalMode, replyTarget });
      // Subscribers can reveal private-session metadata while the controller's
      // reentrancy guard defers its next write. Retire that captured scope now.
      if (
        !incognito &&
        isChatComposerOwnerCurrent(state, owner) &&
        isIncognitoComposerScope(state, captured.scope)
      ) {
        loadCapturedChatComposerState(state, captured.scope);
      }
      return "persisted";
    }
    // Retention limits can make a successful storage write omit this draft.
    // Only a same/newer revision is a concurrency conflict; a missing or older
    // row remains retryable as a storage-capacity failure.
    return (persisted?.draftRevision ?? 0) >= draftRevision ? "conflict" : "storage-failed";
  } catch {
    // Best-effort only: quota and privacy-mode storage errors should not break chat.
    return "storage-failed";
  }
}

export function persistChatComposerState(
  state: ChatComposerPersistenceState,
  sessionKey: string = state.sessionKey,
  options: ChatComposerPersistOptions = {},
): boolean {
  return (
    persistCapturedChatComposerStateResult(
      state,
      captureChatOutboxAdmission(state, sessionKey, options.agentId),
      options,
    ) === "persisted"
  );
}
