import type { DurableComposerDraftScope } from "../../lib/chat/composer-draft-store.runtime.ts";
import { nextDraftRevision } from "../../lib/chat/outbox-store-draft-state.ts";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store-scope.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import { replaceChatOutboxQueue } from "./chat-outbox-queue.ts";
import {
  CHAT_COMPOSER_DRAFT_STORAGE_ERROR,
  loadChatComposerState,
  loadCapturedChatComposerState,
  markChatComposerEdit,
  persistCapturedChatComposerStateResult,
  persistChatComposerState,
} from "./composer-draft-storage.ts";
import { chatAttachmentDraftSignature, normalizeChatComposerDraft } from "./composer-draft.ts";
import { captureChatComposerDraftSnapshot } from "./composer-persistence-snapshot.ts";
import {
  type captureChatComposerOwner,
  resolveChatComposerDurableScope,
  isChatComposerOwnerCurrent,
  isIncognitoComposerScope,
  type ChatComposerPersistenceState,
  type DurableChatComposerPersistenceState,
  type ChatComposerDraftSnapshot,
  type RestoreOptions,
  type ChatComposerPersistResult,
  type ChatComposerPersistStatus,
} from "./composer-persistence-state.ts";
import {
  DurableChatComposerPersistence,
  durableComposerScopeIdentity,
} from "./durable-composer-persistence.ts";

const CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS = 200;

function restoreChatComposerState(
  state: ChatComposerPersistenceState,
  options: RestoreOptions = {},
): boolean {
  state.chatMessage = normalizeChatComposerDraft(state.chatMessage);
  const sessionKey = options.sessionKey ?? state.sessionKey;
  const snapshot = loadChatComposerState(state, sessionKey).snapshot;
  if (!snapshot) {
    return false;
  }
  if (
    !isIncognitoComposerScope(state, resolveUiConversationIdentity(state, sessionKey)) &&
    (!options.preserveCurrent ||
      (!state.chatMessage && !state.chatGoalDraftMode && !state.chatReplyTarget))
  ) {
    state.chatMessage = snapshot.draft;
    state.chatMentions = snapshot.mentions;
    state.chatGoalDraftMode = snapshot.goalMode ?? null;
    state.chatReplyTarget = snapshot.replyTarget ?? null;
  }
  if ((!options.preserveCurrent && snapshot.queue.length > 0) || state.chatQueue.length === 0) {
    replaceChatOutboxQueue(state, snapshot.queue);
  }
  return true;
}

export class ChatComposerPersistence {
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private ready = false;
  private pending: ChatComposerDraftSnapshot | null = null;
  private publishing = false;
  private lastPersisted: ChatComposerDraftSnapshot | null = null;
  private committedDraftRevision = 0;
  private latestDraftRevision = 0;
  private durableRestoreProtected = false;
  // A transient disconnect invalidates scope readiness, not the owner authenticated
  // by this client. Client or Gateway replacement still fences the cached owner.
  private durableOwner: ReturnType<typeof captureChatComposerOwner> | null = null;
  private durableRetiredScopeKey = "";
  private forceDurableOwnerRestore = false;
  private readonly durablePersistence = new DurableChatComposerPersistence(
    () => {
      const state = this.getState();
      if (!state) {
        return;
      }
      state.lastError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
      state.chatError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
    },
    () => this.persistChangedState(),
  );

  constructor(
    private readonly getState: () => DurableChatComposerPersistenceState | undefined,
    private readonly onRestored: () => void = () => {},
  ) {}

  get active(): boolean {
    return this.ready;
  }

  get durableScope() {
    const state = this.getState();
    return state ? this.resolveDurableScope(state) : null;
  }

  get presentationOwner() {
    return this.lastPersisted?.owner;
  }

  get draftRevision(): number {
    return this.latestDraftRevision;
  }

  start() {
    const state = this.getState();
    if (!state) {
      return;
    }
    this.ready = true;
    this.pending = null;
    const { revisions, snapshot: stored } = loadChatComposerState(state, state.sessionKey);
    this.committedDraftRevision = revisions.committed;
    this.latestDraftRevision = revisions.latestAttempt;
    this.durableRestoreProtected =
      (state.chatAttachments?.length ?? 0) > 0 ||
      (stored?.draft ?? "") !== state.chatMessage ||
      JSON.stringify(stored?.mentions ?? []) !== JSON.stringify(state.chatMentions ?? []) ||
      JSON.stringify(stored?.goalMode ?? null) !==
        JSON.stringify(state.chatGoalDraftMode ?? null) ||
      JSON.stringify(stored?.replyTarget ?? null) !== JSON.stringify(state.chatReplyTarget ?? null);
    this.durablePersistence.resetRestoreScope();
    this.lastPersisted = this.snapshot(state, revisions.committed, revisions.committed);
    this.synchronizeDurablePersistence();
  }

  stop() {
    this.persistNow();
    this.ready = false;
    this.durablePersistence.resetRestoreScope();
    this.pending = null;
    this.clearTimer();
  }

  restore(options: RestoreOptions = {}): boolean {
    const state = this.getState();
    if (!state) {
      return false;
    }
    const restored = restoreChatComposerState(state, options);
    this.pending = null;
    this.clearTimer();
    const { revisions } = loadChatComposerState(state, state.sessionKey);
    this.committedDraftRevision = revisions.committed;
    this.latestDraftRevision = revisions.latestAttempt;
    this.lastPersisted = this.snapshot(state, revisions.committed, revisions.committed);
    this.durableRestoreProtected = false;
    this.durablePersistence.resetRestoreScope();
    this.onRestored();
    return restored;
  }

  schedule() {
    const state = this.getState();
    if (!this.ready || !state) {
      return;
    }
    const unchanged = this.isUnchanged(state);
    if (unchanged && !this.pending) {
      this.clearTimer();
      return;
    }
    if (!unchanged || !this.pending || !this.matchesCurrentContent(this.pending, state)) {
      const baseline = Math.max(this.latestDraftRevision, this.pending?.draftRevision ?? 0);
      const draftRevision = nextDraftRevision(baseline);
      this.latestDraftRevision = draftRevision;
      this.pending = this.snapshot(state, draftRevision);
      // An edit owns the draft before its debounced write. Otherwise another
      // pane's older async action can publish over it and fence out that write.
      markChatComposerEdit(state, draftRevision);
    }
    this.clearTimer();
    this.timer = globalThis.setTimeout(
      () => this.persistNow(),
      CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS,
    );
  }

  persistNow() {
    const state = this.getState();
    if (!this.ready || !state || this.publishing) {
      return;
    }
    let snapshot = this.pending;
    if (!snapshot) {
      if (this.isUnchanged(state)) {
        return;
      }
      snapshot = this.snapshot(state, nextDraftRevision(this.latestDraftRevision));
      this.latestDraftRevision = snapshot.draftRevision;
    }
    this.clearTimer();
    this.persistSnapshot(state, snapshot);
  }

  persistChangedState() {
    // Settle the old account’s already-captured durable input before replacing
    // presentation; never mint a new write from it under the incoming account.
    if (this.pending) {
      this.persistNow();
    }
    this.synchronizeDurablePersistence();
    this.persistNow();
  }

  scopeForRouteSwitch(): StoredChatOutboxScope | null {
    const state = this.getState();
    if (!state) {
      return null;
    }
    return (
      (this.pending ?? (this.isUnchanged(state) ? this.lastPersisted : null))?.scope ??
      resolveUiConversationIdentity(state, state.sessionKey)
    );
  }

  persistForRouteSwitchResult(): ChatComposerPersistResult {
    const state = this.getState();
    if (!state) {
      return { status: "persisted" };
    }
    let snapshot = this.pending;
    let enforceExpectedRevision = false;
    if (!snapshot && this.ready && this.isUnchanged(state)) {
      const baseline = this.lastPersisted!;
      if (
        !baseline.chatMessage &&
        !baseline.goalMode &&
        !baseline.replyTarget &&
        baseline.attachments.length === 0
      ) {
        this.pending = null;
        this.clearTimer();
        return { status: "persisted" };
      }
      const { revisions, snapshot: stored } = loadCapturedChatComposerState(state, baseline.scope);
      const storedRevision = revisions.committed;
      if (
        baseline.attachments.length === 0 &&
        storedRevision === baseline.draftRevision &&
        stored?.draft === baseline.chatMessage &&
        JSON.stringify(stored?.mentions ?? []) === JSON.stringify(baseline.mentions ?? []) &&
        JSON.stringify(stored?.goalMode ?? null) === JSON.stringify(baseline.goalMode ?? null) &&
        JSON.stringify(stored?.replyTarget ?? null) === JSON.stringify(baseline.replyTarget ?? null)
      ) {
        this.pending = null;
        this.clearTimer();
        return { status: "persisted" };
      }
      if (
        storedRevision !== baseline.draftRevision ||
        Boolean(stored?.draft || stored?.goalMode || stored?.replyTarget)
      ) {
        return { status: "conflict" };
      }
      // A newer failed attempt still represents newer pane input. An
      // untouched pane must not mint a later revision for its stale draft and
      // fence that edit out merely because retention evicted the stored row.
      if (revisions.latestAttempt > baseline.draftRevision) {
        return { status: "conflict" };
      }
      snapshot = {
        ...baseline,
        expectedDraftRevision: storedRevision,
        draftRevision: nextDraftRevision(
          Math.max(storedRevision, revisions.latestAttempt, this.latestDraftRevision),
        ),
      };
      this.latestDraftRevision = snapshot.draftRevision;
      enforceExpectedRevision = true;
    } else if (
      !snapshot &&
      !this.ready &&
      !normalizeChatComposerDraft(state.chatMessage) &&
      !state.chatGoalDraftMode &&
      !state.chatReplyTarget
    ) {
      this.pending = null;
      this.clearTimer();
      return { status: "persisted" };
    }
    snapshot ??= this.snapshot(state, nextDraftRevision(this.latestDraftRevision));
    this.latestDraftRevision = Math.max(this.latestDraftRevision, snapshot.draftRevision);
    this.clearTimer();
    return this.persistSnapshot(state, snapshot, enforceExpectedRevision);
  }

  private persistSnapshot(
    state: DurableChatComposerPersistenceState,
    snapshot: ChatComposerDraftSnapshot,
    enforceExpectedRevision = false,
  ): ChatComposerPersistResult {
    // Presence notifications synchronously reenter the controller. Publish this
    // exact snapshot first; subscribers must not mint a second write for it.
    this.pending = snapshot;
    this.publishing = true;
    let status: ChatComposerPersistStatus;
    try {
      // A pending snapshot may outlive its authenticated owner. Settle its
      // durable write without publishing into another owner's tab metadata.
      status = isChatComposerOwnerCurrent(state, snapshot.owner)
        ? persistCapturedChatComposerStateResult(state, snapshot, {
            draft: snapshot.chatMessage,
            mentions: snapshot.mentions,
            goalMode: snapshot.goalMode ?? null,
            replyTarget: snapshot.replyTarget ?? null,
            draftRevision: snapshot.draftRevision,
            ...(enforceExpectedRevision
              ? { expectedDraftRevision: snapshot.expectedDraftRevision }
              : {}),
          })
        : "persisted";
    } finally {
      this.publishing = false;
    }
    if (snapshot.durable) {
      if (
        snapshot.incognito ||
        (isChatComposerOwnerCurrent(state, snapshot.owner) &&
          isIncognitoComposerScope(state, snapshot.scope))
      ) {
        this.retireDurableScope(snapshot.durable.scope, snapshot.draftRevision);
      } else {
        void this.durablePersistence.persist(snapshot.durable);
      }
    }
    if (status === "persisted" && this.pending === snapshot) {
      this.pending = null;
      this.committedDraftRevision = snapshot.draftRevision;
      this.latestDraftRevision = Math.max(this.latestDraftRevision, snapshot.draftRevision);
      this.lastPersisted = snapshot;
      return { status };
    }
    if (status === "storage-failed") {
      return {
        status,
        expectedDraftRevision: snapshot.expectedDraftRevision,
        draftRevision: snapshot.draftRevision,
      };
    }
    return { status };
  }

  private clearTimer() {
    if (this.timer === null) {
      return;
    }
    globalThis.clearTimeout(this.timer);
    this.timer = null;
  }

  private isUnchanged(state: ChatComposerPersistenceState): boolean {
    const last = this.lastPersisted;
    // Authentication unlocks durable restoration; it does not edit the draft.
    return Boolean(
      last &&
      last.sessionKey === state.sessionKey &&
      last.incognito === isIncognitoComposerScope(state, last.scope) &&
      this.matchesCurrentContent(last, state),
    );
  }

  private matchesCurrentContent(
    snapshot: ChatComposerDraftSnapshot,
    state: ChatComposerPersistenceState,
  ): boolean {
    return (
      chatAttachmentDraftSignature(
        snapshot.chatMessage,
        snapshot.attachments,
        snapshot.goalMode,
        snapshot.mentions,
        snapshot.replyTarget,
      ) === this.currentContentSignature(state, normalizeChatComposerDraft(state.chatMessage))
    );
  }

  private currentContentSignature(
    state: ChatComposerPersistenceState,
    text = state.chatMessage,
  ): string {
    return chatAttachmentDraftSignature(
      text,
      state.chatAttachments ?? [],
      state.chatGoalDraftMode,
      state.chatMentions,
      state.chatReplyTarget,
    );
  }

  private snapshot(
    state: DurableChatComposerPersistenceState,
    draftRevision: number = this.latestDraftRevision,
    expectedDraftRevision: number = this.committedDraftRevision,
  ): ChatComposerDraftSnapshot {
    return captureChatComposerDraftSnapshot(
      state,
      this.resolveDurableScope(state),
      draftRevision,
      expectedDraftRevision,
      this.lastPersisted,
    );
  }

  private resolveDurableScope(state: DurableChatComposerPersistenceState) {
    const scope = resolveUiConversationIdentity(state, state.sessionKey);
    if (isIncognitoComposerScope(state, scope)) {
      return null;
    }
    return resolveChatComposerDurableScope(state, scope);
  }

  private retireDurableScope(scope: DurableComposerDraftScope, revision: number) {
    const scopeKey = durableComposerScopeIdentity(scope);
    if (this.durableRetiredScopeKey !== scopeKey) {
      this.durableRetiredScopeKey = scopeKey;
      this.durableOwner = null;
      this.forceDurableOwnerRestore = false;
      this.durableRestoreProtected = false;
      void this.durablePersistence.retire(scope, revision);
    }
  }

  private synchronizeDurablePersistence() {
    const state = this.getState();
    if (!this.ready || !state || this.publishing) {
      return;
    }
    const connectedScope = resolveChatComposerDurableScope(state);
    if (isIncognitoComposerScope(state, resolveUiConversationIdentity(state, state.sessionKey))) {
      if (connectedScope) {
        if (
          !this.isUnchanged(state) ||
          (this.lastPersisted && !isChatComposerOwnerCurrent(state, this.lastPersisted.owner))
        ) {
          loadChatComposerState(state, state.sessionKey);
        }
        this.retireDurableScope(connectedScope, this.latestDraftRevision);
      }
      return;
    }
    this.durableRetiredScopeKey = "";
    const scope = this.resolveDurableScope(state);
    if (!scope) {
      return;
    }
    const previousOwner = this.durableOwner;
    // Draft writes notify panes synchronously. Publish the new owner before
    // clearing the old draft so reentrant persistence cannot repeat this transition.
    this.durableOwner = {
      client: state.client,
      gatewayOwner: scope.gatewayOwner,
      recoveryScope: scope.recoveryScope,
    };
    if (
      previousOwner &&
      (previousOwner.gatewayOwner !== scope.gatewayOwner ||
        previousOwner.recoveryScope !== scope.recoveryScope)
    ) {
      releaseChatAttachmentPayloads(state.chatAttachments);
      state.chatMessage = "";
      state.chatMentions = [];
      state.chatGoalDraftMode = null;
      state.chatReplyTarget = null;
      state.chatAttachments = [];
      this.pending = null;
      const { revisions } = loadChatComposerState(state, state.sessionKey);
      this.committedDraftRevision = revisions.committed;
      this.latestDraftRevision = revisions.latestAttempt;
      // Read the replacement account; never clear its saved draft with old presentation.
      restoreChatComposerState(state);
      this.committedDraftRevision = revisions.committed;
      this.lastPersisted = null;
      this.lastPersisted = this.snapshot(state, this.latestDraftRevision, this.latestDraftRevision);
      this.durableRestoreProtected = false;
      this.forceDurableOwnerRestore = true;
      this.durablePersistence.resetRestoreScope();
      this.onRestored();
    }
    if (this.durableRestoreProtected) {
      this.durableRestoreProtected = false;
      const snapshot = this.snapshot(state, nextDraftRevision(this.latestDraftRevision));
      this.latestDraftRevision = snapshot.draftRevision;
      this.persistSnapshot(state, snapshot);
      return;
    }
    this.durablePersistence.restore(
      scope,
      () => {
        const baseline = this.snapshot(state);
        return {
          latestRevision: this.forceDurableOwnerRestore ? 0 : this.latestDraftRevision,
          signature: this.currentContentSignature(state),
          onCurrentWins: (storedRevision) => {
            this.forceDurableOwnerRestore = false;
            if (
              baseline.durable &&
              (state.chatMessage ||
                state.chatGoalDraftMode ||
                state.chatReplyTarget ||
                (state.chatAttachments?.length ?? 0) > 0)
            ) {
              void this.durablePersistence.persist({
                ...baseline.durable,
                expectedRevision: storedRevision,
              });
            }
          },
        };
      },
      () => ({
        scope: this.resolveDurableScope(state),
        signature: this.currentContentSignature(state),
        revision: this.forceDurableOwnerRestore ? 0 : this.latestDraftRevision,
      }),
      (draft) => {
        const forceOwnerRestore = this.forceDurableOwnerRestore;
        this.forceDurableOwnerRestore = false;
        const displaced = state.chatAttachments ?? [];
        state.chatMessage = normalizeChatComposerDraft(draft.text);
        state.chatMentions = draft.mentions;
        state.chatGoalDraftMode = draft.goalMode ?? null;
        state.chatReplyTarget = draft.replyTarget ?? null;
        state.chatAttachments = draft.attachments;
        releaseChatAttachmentPayloads(displaced);
        const adoptedRevision = forceOwnerRestore
          ? nextDraftRevision(Math.max(this.latestDraftRevision, draft.revision))
          : draft.revision;
        // Storage presence notifications synchronously invalidate every pane. Adopt
        // the complete restored draft before they can schedule another write.
        this.committedDraftRevision = adoptedRevision;
        this.latestDraftRevision = adoptedRevision;
        this.lastPersisted = this.snapshot(state, adoptedRevision, adoptedRevision);
        persistChatComposerState(state, state.sessionKey, {
          agentId: resolveUiConversationIdentity(state, state.sessionKey).agentId,
          draft: state.chatMessage,
          mentions: state.chatMentions,
          goalMode: state.chatGoalDraftMode,
          replyTarget: state.chatReplyTarget,
          draftRevision: adoptedRevision,
        });
        if (forceOwnerRestore && this.lastPersisted.durable) {
          void this.durablePersistence.persist({
            ...this.lastPersisted.durable,
            expectedRevision: draft.revision,
          });
        }
        this.onRestored();
      },
    );
  }
}
