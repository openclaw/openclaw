import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import type {
  DurableComposerDraftScope,
  DurableDraftModelSelection,
} from "../../lib/chat/composer-draft-store.runtime.ts";
import { nextDraftRevision } from "../../lib/chat/outbox-store-draft-state.ts";
import { storageTargetForGateway } from "../../lib/chat/outbox-store.ts";
import {
  captureDurableChatAttachments,
  chatAttachmentDraftSignature,
  durableComposerScopeIdentity,
  hydrateDurableComposerAttachments,
  reportDurableComposerStorageError,
  writeDurableComposerSnapshot,
  type DurableChatComposerSnapshot,
} from "../chat/durable-composer-persistence.ts";

type NewSessionDraftState = {
  message: string;
  mentions?: readonly HumanMention[];
  attachments: ChatAttachment[];
  incognito: boolean;
};

type DraftRetirement = { revision: number; writeId?: string };
type DraftLineage = {
  revision: number;
  writeId?: string;
  localWriteIds: Set<string>;
  retirement?: Promise<DraftRetirement | undefined>;
};
type DraftMutation = {
  writeId: string;
  retired: boolean;
  committedRevision: number;
  writes: Set<Promise<void>>;
};
type PendingDraftSnapshot = DurableChatComposerSnapshot & {
  mutation: DraftMutation;
  retirement?: Promise<DraftRetirement | undefined>;
};
export type NewSessionDraftHandoff = ReturnType<NewSessionDraftPersistence["captureSubmission"]>;
const createMutation = (): DraftMutation => ({
  writeId: Math.random().toString(36).slice(2),
  retired: false,
  committedRevision: 0,
  writes: new Set(),
});

const durableComposerStore = import("../../lib/chat/composer-draft-store.runtime.ts");
const NEW_SESSION_DRAFT_PERSIST_DELAY_MS = 200;

export class NewSessionDraftPersistence {
  modelSelection:
    | {
        read: () => DurableDraftModelSelection | undefined;
        restore: (selection: DurableDraftModelSelection | undefined) => void;
        retire: () => void;
      }
    | undefined;
  private restorePromise: Promise<boolean> | undefined;
  private contentReconciled = false;
  private pendingModelSelectionMutation = false;
  private gatewayOwner = "";
  private recoveryScope = "";
  private routeKey = "";
  private revision = 0;
  private mutationGeneration = 0;
  private mutation = createMutation();
  private inheritedWriteIds: readonly (string | undefined)[] = [];
  private disconnected = false;
  private pendingHandoffMutation: DraftMutation | null = null;
  private submittedMutation: DraftMutation | null = null;
  // Mutation counter at the last programmatic content replacement (reset,
  // handoff, restore). A generation beyond it means the composer holds text
  // the user typed; a restore must never apply over that, and `revision`
  // cannot arbitrate because `selectRoute` zeroes it after late owner setup.
  private pristineMutationBaseline = 0;
  private restoreGeneration = 0;
  private restoredIdentity = "";
  private pending: PendingDraftSnapshot | null = null;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private readonly lineageByScope = new Map<string, DraftLineage>();
  // Mounted views are projections of the durable draft. A departed submitter
  // can retire their restored copy without owning their newer edits.
  private static readonly active = new Set<NewSessionDraftPersistence>();

  constructor(
    private readonly read: () => NewSessionDraftState,
    private readonly apply: (
      message: string,
      attachments: ChatAttachment[],
      resetVisibility?: boolean,
      mentions?: readonly HumanMention[],
    ) => void,
    private readonly onStorageError: () => void,
  ) {}

  setOwner(gatewayUrl: string, recoveryScope: string, preserveCurrent = false) {
    const gatewayOwner = storageTargetForGateway(gatewayUrl).gatewayOwner;
    const nextOwner = JSON.stringify([gatewayOwner, recoveryScope]);
    const currentOwner = this.gatewayOwner
      ? JSON.stringify([this.gatewayOwner, this.recoveryScope])
      : "";
    if (currentOwner === nextOwner) {
      return;
    }
    const routeKey = this.routeKey;
    this.persistNow();
    this.restoreGeneration += 1;
    this.restoredIdentity = "";
    this.contentReconciled = false;
    this.routeKey = "";
    this.gatewayOwner = gatewayOwner;
    this.recoveryScope = recoveryScope;
    if (currentOwner && !preserveCurrent) {
      this.pendingModelSelectionMutation = false;
      this.apply("", [], true);
    }
    // The route may win the startup race; activate it as soon as its owner exists.
    if (!preserveCurrent) {
      this.activateRoute(routeKey);
    }
  }

  setIncognito(incognito: boolean): Promise<void> {
    if (incognito) {
      return this.retireActive();
    }
    const scope = this.scope();
    return (
      (scope ? this.lineage(scope).retirement : undefined)?.then(() => {}) ?? Promise.resolve()
    );
  }

  transitionIncognito(wasIncognito: boolean, incognito: boolean, publish: () => void) {
    const transition = this.setIncognito(incognito);
    if (wasIncognito && !incognito) {
      // Capture this route's input before navigation can replace the composer.
      this.noteUserMutation();
      void transition.finally(publish);
      return;
    }
    publish();
  }

  selectRoute(routeKey: string) {
    if (!routeKey) {
      return;
    }
    if (this.routeKey !== routeKey) {
      this.persistNow();
      if (this.routeKey) {
        this.pendingModelSelectionMutation = false;
      }
      this.routeKey = routeKey;
      this.contentReconciled = false;
      this.revision = 0;
    }
  }

  activateRoute(routeKey: string) {
    this.selectRoute(routeKey);
    const scope = this.scope();
    if (!scope) {
      return;
    }
    const identity = durableComposerScopeIdentity(scope);
    if (identity === this.restoredIdentity) {
      return;
    }
    this.restoredIdentity = identity;
    this.contentReconciled = false;
    if (this.read().incognito) {
      void this.retireActive();
      return;
    }
    const generation = ++this.restoreGeneration;
    const mutationGeneration = this.mutationGeneration;
    const baseline = this.read();
    const signature = chatAttachmentDraftSignature(
      baseline.message,
      baseline.attachments,
      undefined,
      baseline.mentions,
    );
    const restoring = this.restoreScope(scope, generation, mutationGeneration, signature);
    this.restorePromise = restoring;
    void restoring.then(
      (reconciled) => {
        if (this.restorePromise === restoring) {
          this.restorePromise = undefined;
          this.contentReconciled = reconciled;
          this.flushModelSelectionMutation();
        }
      },
      () => {
        if (this.restorePromise === restoring) {
          this.restorePromise = undefined;
          this.contentReconciled = false;
          reportDurableComposerStorageError(scope, this.onStorageError);
        }
      },
    );
  }

  noteDraftReplaced() {
    this.restoreGeneration += 1;
    this.mutationGeneration += 1;
    this.mutation = createMutation();
    this.pendingHandoffMutation = null;
    this.submittedMutation = null;
    this.inheritedWriteIds = [];
    this.pristineMutationBaseline = this.mutationGeneration;
  }

  noteModelSelectionMutation() {
    // A pristine submission cancels content hydration; a rejected create must not
    // let the next model-only edit CAS-write the still-empty composer over that content.
    const rehydrate =
      !this.contentReconciled &&
      this.mutationGeneration === this.pristineMutationBaseline &&
      (this.submittedMutation === this.mutation || !this.restorePromise);
    this.submittedMutation = null;
    this.pendingModelSelectionMutation = true;
    if (rehydrate) {
      this.restoredIdentity = "";
      this.activateRoute(this.routeKey);
    } else {
      this.flushModelSelectionMutation();
    }
  }

  private flushModelSelectionMutation() {
    if (
      this.pendingModelSelectionMutation &&
      !this.restorePromise &&
      this.restoredIdentity &&
      (this.contentReconciled || this.mutationGeneration > this.pristineMutationBaseline) &&
      !this.disconnected &&
      this.submittedMutation !== this.mutation
    ) {
      this.noteUserMutation();
    }
  }

  noteUserMutation() {
    this.pendingModelSelectionMutation = false;
    this.mutationGeneration += 1;
    this.mutation = createMutation();
    this.pendingHandoffMutation = null;
    this.submittedMutation = null;
    this.revision = nextDraftRevision(this.revision);
    if (this.read().incognito) {
      return;
    }
    this.discardPending();
    const snapshot = this.snapshot();
    if (!snapshot) {
      return;
    }
    this.pending = snapshot;
    this.timer = globalThis.setTimeout(() => this.persistNow(), NEW_SESSION_DRAFT_PERSIST_DELAY_MS);
  }

  retireActive(): Promise<void> {
    this.mutationGeneration += 1;
    this.mutation.retired = true;
    this.discardPending();
    const requestedRevision = nextDraftRevision(this.revision);
    this.revision = requestedRevision;
    const scope = this.scope();
    if (!scope) {
      return Promise.resolve();
    }
    const lineage = this.lineage(scope);
    // Revoke delayed writes immediately, including older edits of this route.
    lineage.localWriteIds.clear();
    lineage.retirement = (async () => {
      const { retireDurableComposerDraft } = await durableComposerStore;
      const minimumRevision = Math.max(requestedRevision, lineage.revision);
      const result = await retireDurableComposerDraft(scope, minimumRevision);
      if (result.status === "storage-failed") {
        reportDurableComposerStorageError(scope, this.onStorageError);
      } else if (result.status === "persisted") {
        const revision = result.revision ?? minimumRevision;
        this.adoptCommittedRevision(scope, revision, result.writeId);
        return { revision, writeId: result.writeId };
      }
      return undefined;
    })();
    return lineage.retirement.then(() => {});
  }

  captureSubmission() {
    this.pendingModelSelectionMutation = false;
    this.reconcileHandoffCommit();
    this.submittedMutation = this.mutation;
    // Freeze pristine restoration; a dirty draft must still finish its CAS
    // retry under the captured mutation until acceptance retires that work.
    if (this.mutationGeneration === this.pristineMutationBaseline) {
      if (this.restorePromise) {
        this.contentReconciled = false;
      }
      this.restoreGeneration += 1;
    }
    this.persistNow();
    const scope = this.scope();
    const lineage = scope ? this.lineage(scope) : null;
    return {
      scope,
      mutation: this.mutation,
      revision: this.revision,
      incognito: this.read().incognito,
      pendingEdit:
        this.mutationGeneration > this.pristineMutationBaseline &&
        this.mutation.committedRevision === 0,
      writeIds: new Set([
        lineage?.writeId,
        this.mutation.writeId,
        ...this.inheritedWriteIds,
        ...(lineage?.localWriteIds ?? []),
      ]),
    };
  }

  adoptHandoff(handoff: NewSessionDraftHandoff) {
    const scope = this.scope();
    if (
      scope &&
      handoff.scope &&
      durableComposerScopeIdentity(scope) === durableComposerScopeIdentity(handoff.scope)
    ) {
      this.mutation = handoff.mutation;
      this.revision = Math.max(this.revision, handoff.revision);
      if (handoff.pendingEdit && !handoff.mutation.committedRevision) {
        this.pristineMutationBaseline = this.mutationGeneration - 1;
        this.pendingHandoffMutation = handoff.mutation;
      }
      this.inheritedWriteIds = [...handoff.writeIds];
    }
  }

  async clearSubmittedDraft(
    submitted: ReturnType<NewSessionDraftPersistence["captureSubmission"]>,
    consume?: () => void,
  ): Promise<void> {
    submitted.mutation.retired = true;
    const { scope } = submitted;
    const currentScope = this.scope();
    if (
      this.mutation === submitted.mutation &&
      ((!scope && !currentScope) ||
        (scope &&
          currentScope &&
          durableComposerScopeIdentity(scope) === durableComposerScopeIdentity(currentScope)))
    ) {
      this.modelSelection?.retire();
      consume?.();
    }
    // Fence retries before waiting: already-started writes settle before the CAS,
    // while delayed conflict restores can no longer republish this mutation.
    await Promise.all(submitted.mutation.writes);
    if (!scope) {
      return;
    }
    const { readDurableComposerDraft } = await durableComposerStore;
    // Retire captured writes, including the store's text-only oversized-file
    // projection. A newer edit has a different write ID even when its text matches.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await readDurableComposerDraft(scope);
      if (current.status === "storage-failed") {
        reportDurableComposerStorageError(scope, this.onStorageError);
        return;
      }
      const currentRevision =
        (current.status === "found" ? current.draft.revision : current.revision) ?? 0;
      const currentWriteId = current.status === "found" ? current.draft.writeId : current.writeId;
      if (current.status !== "found" || !submitted.writeIds.has(current.draft.writeId)) {
        return;
      }
      const revision = nextDraftRevision(currentRevision);
      const writeId = `clear:${revision}`;
      const { result } = await writeDurableComposerSnapshot({
        scope,
        expectedRevision: currentRevision,
        ...(currentWriteId ? { expectedWriteId: currentWriteId } : {}),
        revision,
        text: "",
        storedAttachments: [],
        writeId,
      });
      if (result.status === "persisted") {
        this.adoptCommittedRevision(scope, result.revision ?? revision, result.writeId ?? writeId);
        for (const view of NewSessionDraftPersistence.active) {
          const activeScope = view.scope();
          if (
            activeScope &&
            durableComposerScopeIdentity(activeScope) === durableComposerScopeIdentity(scope)
          ) {
            view.restoredIdentity = "";
            view.activateRoute(activeScope.scopeKey);
          }
        }
        return;
      }
      if (result.status === "storage-failed") {
        reportDurableComposerStorageError(scope, this.onStorageError);
        return;
      }
    }
  }

  persistNow() {
    this.clearTimer();
    const snapshot = this.pending;
    if (!snapshot) {
      return;
    }
    if (this.read().incognito) {
      this.discardPending();
      return;
    }
    this.pending = null;
    // Start each captured write before teardown; native transactions and CAS
    // order writes without delaying attachments behind a promise chain.
    const writing = (async () => {
      try {
        const retirement = snapshot.retirement ? await snapshot.retirement : undefined;
        if (
          snapshot.mutation.retired ||
          !this.lineage(snapshot.scope).localWriteIds.has(snapshot.writeId)
        ) {
          return;
        }
        const write =
          retirement && retirement.revision > snapshot.expectedRevision
            ? {
                ...snapshot,
                expectedRevision: retirement.revision,
                expectedWriteId: retirement.writeId,
                revision: nextDraftRevision(Math.max(snapshot.revision, retirement.revision)),
              }
            : snapshot;
        const { result, payloadUnavailable } = await writeDurableComposerSnapshot(write);
        if (payloadUnavailable) {
          reportDurableComposerStorageError(snapshot.scope, this.onStorageError);
        }
        if (result.status === "persisted" || result.status === "payload-too-large") {
          const committedRevision = result.revision ?? write.revision;
          snapshot.mutation.committedRevision = committedRevision;
          this.adoptCommittedRevision(
            snapshot.scope,
            committedRevision,
            result.writeId ?? snapshot.writeId,
          );
          if (result.status === "payload-too-large") {
            reportDurableComposerStorageError(snapshot.scope, this.onStorageError);
          }
          return;
        }
        if (result.status === "storage-failed") {
          reportDurableComposerStorageError(snapshot.scope, this.onStorageError);
          return;
        }
        if (
          this.disconnected ||
          snapshot.mutation.retired ||
          this.routeKey !== snapshot.scope.scopeKey ||
          this.revision !== snapshot.revision
        ) {
          return;
        }
        this.restoredIdentity = "";
        this.activateRoute(this.routeKey);
      } finally {
        this.forgetLocalWrite(snapshot);
      }
    })();
    snapshot.mutation.writes.add(writing);
    void writing.finally(() => snapshot.mutation.writes.delete(writing));
  }

  connect() {
    this.disconnected = false;
    NewSessionDraftPersistence.active.add(this);
  }

  disconnect() {
    this.disconnected = true;
    NewSessionDraftPersistence.active.delete(this);
    this.persistNow();
    this.restoreGeneration += 1;
  }

  private scope(): DurableComposerDraftScope | null {
    if (!this.gatewayOwner || !this.recoveryScope || !this.routeKey) {
      return null;
    }
    return {
      gatewayOwner: this.gatewayOwner,
      recoveryScope: this.recoveryScope,
      scopeKey: this.routeKey,
    };
  }

  private snapshot(): PendingDraftSnapshot | null {
    const scope = this.scope();
    if (!scope || this.revision <= 0 || this.mutation.retired) {
      return null;
    }
    const state = this.read();
    const lineage = this.lineage(scope);
    const expectedWriteIds = [...lineage.localWriteIds];
    // A CAS retry republishes this mutation, not a new user edit. Keep its
    // identity stable so a captured submission can retire the successful retry.
    const writeId = this.mutation.writeId;
    lineage.localWriteIds.add(writeId);
    return {
      scope,
      mutation: this.mutation,
      retirement: lineage.retirement,
      expectedRevision: lineage.revision,
      ...(lineage.writeId ? { expectedWriteId: lineage.writeId } : {}),
      expectedWriteIds,
      revision: this.revision,
      text: state.message,
      ...(state.mentions?.length
        ? { mentions: state.mentions.map((mention) => ({ ...mention })) }
        : {}),
      modelSelection: this.modelSelection?.read(),
      storedAttachments: captureDurableChatAttachments(state.attachments),
      writeId,
    };
  }

  private async restoreScope(
    scope: DurableComposerDraftScope,
    generation: number,
    mutationGeneration: number,
    signature: string,
  ): Promise<boolean> {
    const { readDurableComposerDraft } = await durableComposerStore;
    const result = await readDurableComposerDraft(scope);
    if (result.status === "storage-failed") {
      reportDurableComposerStorageError(scope, this.onStorageError);
      return false;
    }
    const storedRevision = result.status === "found" ? result.draft.revision : result.revision;
    const storedWriteId = result.status === "found" ? result.draft.writeId : result.writeId;
    const lineage = this.lineage(scope);
    // An absent authoritative row clears committed facts, never in-flight IDs.
    lineage.revision = storedRevision ?? 0;
    lineage.writeId = storedWriteId;
    const current = this.read();
    const currentScope = this.scope();
    if (
      generation !== this.restoreGeneration ||
      mutationGeneration !== this.mutationGeneration ||
      !currentScope ||
      durableComposerScopeIdentity(scope) !== durableComposerScopeIdentity(currentScope) ||
      signature !==
        chatAttachmentDraftSignature(
          current.message,
          current.attachments,
          undefined,
          current.mentions,
        )
    ) {
      return false;
    }
    this.reconcileHandoffCommit();
    if (this.submittedMutation === this.mutation && this.mutation.committedRevision > 0) {
      return false;
    }
    // Restore only into a pristine composer: anything the user typed on this
    // route wins over the stored draft, even when the stored revision is
    // higher (after a reload `revision` restarts at 0, so revision order
    // cannot arbitrate against live input).
    if (
      storedRevision === undefined ||
      storedRevision < this.revision ||
      mutationGeneration > this.pristineMutationBaseline
    ) {
      if (storedRevision !== undefined && storedRevision >= this.revision) {
        this.revision = nextDraftRevision(storedRevision);
      } else if (this.revision <= 0 && mutationGeneration > this.pristineMutationBaseline) {
        // Text typed before route activation: selectRoute zeroed its revision,
        // so mint one or the snapshot below is empty and the draft never lands.
        this.revision = nextDraftRevision(0);
      }
      this.pending = this.snapshot();
      this.persistNow();
      return true;
    }
    let attachments: ChatAttachment[] = [];
    if (result.status === "found") {
      try {
        attachments = await hydrateDurableComposerAttachments(result.draft.attachments);
      } catch {
        reportDurableComposerStorageError(scope, this.onStorageError);
        return false;
      }
    }
    const hydratedCurrent = this.read();
    const hydratedScope = this.scope();
    if (
      generation !== this.restoreGeneration ||
      mutationGeneration !== this.mutationGeneration ||
      !hydratedScope ||
      durableComposerScopeIdentity(scope) !== durableComposerScopeIdentity(hydratedScope) ||
      signature !==
        chatAttachmentDraftSignature(
          hydratedCurrent.message,
          hydratedCurrent.attachments,
          undefined,
          hydratedCurrent.mentions,
        )
    ) {
      return false;
    }
    this.revision = storedRevision;
    if (result.status === "found" && result.draft.mentions) {
      this.apply(result.draft.text, attachments, undefined, result.draft.mentions);
    } else {
      this.apply(result.status === "found" ? result.draft.text : "", attachments);
    }
    this.modelSelection?.restore(
      result.status === "found" ? result.draft.modelSelection : undefined,
    );
    this.mutation.committedRevision = storedRevision;
    return true;
  }

  private reconcileHandoffCommit() {
    if (
      this.pendingHandoffMutation === this.mutation &&
      this.mutation.committedRevision > 0 &&
      this.submittedMutation !== this.mutation
    ) {
      // A transferred write can settle after adoption. Once saved, the handoff
      // is a cache again; later durable edits win unless this view has submitted it.
      this.revision = Math.max(this.revision, this.mutation.committedRevision);
      this.pristineMutationBaseline = this.mutationGeneration;
      this.pendingHandoffMutation = null;
    }
  }

  private clearTimer() {
    if (this.timer === null) {
      return;
    }
    globalThis.clearTimeout(this.timer);
    this.timer = null;
  }

  private discardPending() {
    this.clearTimer();
    const snapshot = this.pending;
    this.pending = null;
    if (!snapshot) {
      return;
    }
    this.forgetLocalWrite(snapshot);
  }

  private forgetLocalWrite(snapshot: DurableChatComposerSnapshot) {
    const identity = durableComposerScopeIdentity(snapshot.scope);
    const lineage = this.lineageByScope.get(identity);
    if (!lineage) {
      return;
    }
    lineage.localWriteIds.delete(snapshot.writeId);
    if (
      !lineage.revision &&
      !lineage.writeId &&
      !lineage.localWriteIds.size &&
      !lineage.retirement
    ) {
      this.lineageByScope.delete(identity);
    }
  }

  private lineage(scope: DurableComposerDraftScope): DraftLineage {
    const identity = durableComposerScopeIdentity(scope);
    let lineage = this.lineageByScope.get(identity);
    if (!lineage) {
      lineage = { revision: 0, localWriteIds: new Set() };
      this.lineageByScope.set(identity, lineage);
    }
    return lineage;
  }

  private adoptCommittedRevision(
    scope: DurableComposerDraftScope,
    revision: number,
    writeId?: string,
  ) {
    const identity = durableComposerScopeIdentity(scope);
    const lineage = this.lineage(scope);
    lineage.revision = revision;
    if (writeId) {
      lineage.writeId = writeId;
    }
    const currentScope = this.scope();
    if (
      currentScope &&
      durableComposerScopeIdentity(currentScope) === identity &&
      revision > this.revision
    ) {
      this.revision = revision;
    }
  }
}
