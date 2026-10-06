import { readBlobAsDataUrl } from "../../lib/blob-data-url.ts";
import type {
  ChatAttachment,
  ChatGoalDraftMode,
  ChatReplyTarget,
  DurableComposerDraftAttachment,
  HumanMention,
} from "../../lib/chat/chat-types.ts";
import type {
  DurableComposerDraft,
  DurableComposerDraftScope,
  writeDurableComposerDraft,
} from "../../lib/chat/composer-draft-store.runtime.ts";
import { readChatSelectionAnnotation } from "../../lib/chat/selection-annotation.ts";
import { generateAttachmentId, getChatAttachmentBlob } from "./attachment-payload-store.ts";

export type DurableChatComposerSnapshot = Omit<
  DurableComposerDraft,
  "attachments" | "questionDrafts"
> &
  Parameters<typeof writeDurableComposerDraft>[2] & {
    scope: DurableComposerDraftScope;
    storedAttachments: DurableComposerDraftAttachment[] | null;
  };

type RestoreBaseline = {
  scope: DurableComposerDraftScope;
  latestRevision: number;
  signature: string;
};

type RestoredDraft = Pick<
  DurableComposerDraft,
  "revision" | "text" | "mentions" | "goalMode" | "replyTarget"
> & {
  attachments: ChatAttachment[];
};

const reportedStorageOwners = new Set<string>();

const durableComposerStore = import("../../lib/chat/composer-draft-store.runtime.ts");

function durableComposerOwnerKey(scope: DurableComposerDraftScope): string {
  return JSON.stringify([scope.gatewayOwner, scope.recoveryScope]);
}

export function durableComposerScopeIdentity(scope: DurableComposerDraftScope): string {
  return JSON.stringify([scope.gatewayOwner, scope.recoveryScope, scope.scopeKey]);
}

export function reportDurableComposerStorageError(
  scope: DurableComposerDraftScope,
  onStorageError: () => void,
) {
  const owner = durableComposerOwnerKey(scope);
  if (reportedStorageOwners.has(owner)) {
    return;
  }
  reportedStorageOwners.add(owner);
  onStorageError();
}

export function chatAttachmentDraftSignature(
  text: string,
  attachments: readonly ChatAttachment[],
  goalMode?: ChatGoalDraftMode | null,
  mentions?: readonly HumanMention[],
  replyTarget?: ChatReplyTarget | null,
): string {
  // Admission and recovery mint a new ID for each payload. Preview URLs and
  // moving the same bytes between Blob/data-URL storage do not change that owner.
  return JSON.stringify([
    text,
    goalMode ?? null,
    mentions ?? [],
    replyTarget
      ? [
          replyTarget.messageId,
          replyTarget.text,
          replyTarget.senderLabel ?? null,
          replyTarget.sourceMessageId ?? null,
        ]
      : null,
    attachments.map((attachment) => [
      attachment.id,
      attachment.mimeType,
      attachment.origin ?? null,
      attachment.fileName ?? "",
      attachment.sizeBytes ?? -1,
      attachment.browserAnnotation ?? null,
      attachment.selectionAnnotation ?? null,
    ]),
  ]);
}

export function captureDurableChatAttachments(
  attachments: readonly ChatAttachment[],
): DurableComposerDraftAttachment[] | null {
  const stored: DurableComposerDraftAttachment[] = [];
  for (const attachment of attachments) {
    const blob = getChatAttachmentBlob(attachment);
    if (!blob) {
      return null;
    }
    stored.push({
      blob,
      mimeType: attachment.mimeType,
      ...(attachment.origin ? { origin: attachment.origin } : {}),
      ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
      ...(typeof attachment.sizeBytes === "number" ? { sizeBytes: attachment.sizeBytes } : {}),
      ...(attachment.browserAnnotation
        ? { browserAnnotation: { ...attachment.browserAnnotation } }
        : {}),
      ...(attachment.selectionAnnotation
        ? { selectionAnnotation: { ...attachment.selectionAnnotation } }
        : {}),
    });
  }
  return stored;
}

export async function hydrateDurableComposerAttachments(
  stored: readonly DurableComposerDraftAttachment[],
): Promise<ChatAttachment[]> {
  // No registry or URL ownership until the complete batch reaches a live owner.
  return Promise.all(
    stored.map(async ({ blob, selectionAnnotation, ...metadata }) => {
      const annotation = readChatSelectionAnnotation(selectionAnnotation);
      const source =
        blob.type === metadata.mimeType ? blob : blob.slice(0, blob.size, metadata.mimeType);
      return {
        ...metadata,
        id: generateAttachmentId(),
        ...(metadata.browserAnnotation
          ? { browserAnnotation: { ...metadata.browserAnnotation } }
          : {}),
        ...(annotation ? { selectionAnnotation: annotation } : {}),
        dataUrl: await readBlobAsDataUrl(source),
      };
    }),
  );
}

export async function writeDurableComposerSnapshot(snapshot: DurableChatComposerSnapshot) {
  const { writeDurableComposerDraft } = await durableComposerStore;
  const payloadUnavailable = snapshot.storedAttachments === null;
  const result = await writeDurableComposerDraft(
    snapshot.scope,
    {
      revision: snapshot.revision,
      text: payloadUnavailable ? "" : snapshot.text,
      ...(snapshot.mentions?.length && !payloadUnavailable ? { mentions: snapshot.mentions } : {}),
      ...(snapshot.goalMode ? { goalMode: snapshot.goalMode } : {}),
      ...(snapshot.replyTarget ? { replyTarget: snapshot.replyTarget } : {}),
      ...(snapshot.modelSelection ? { modelSelection: snapshot.modelSelection } : {}),
      attachments: snapshot.storedAttachments ?? [],
    },
    {
      expectedRevision: snapshot.expectedRevision,
      ...(snapshot.expectedWriteId ? { expectedWriteId: snapshot.expectedWriteId } : {}),
      ...(snapshot.expectedWriteIds?.length ? { expectedWriteIds: snapshot.expectedWriteIds } : {}),
      writeId: snapshot.writeId,
    },
  );
  return { result, payloadUnavailable };
}

export class DurableChatComposerPersistence {
  private restoreGeneration = 0;
  private restoredScopeKey = "";

  constructor(
    private readonly onStorageError: () => void,
    private readonly onConflict: () => void,
  ) {}

  resetRestoreScope() {
    this.restoreGeneration += 1;
    this.restoredScopeKey = "";
  }

  async persist(snapshot: DurableChatComposerSnapshot) {
    // Start every CAS write before page teardown. IndexedDB readwrite ordering and
    // draft revisions serialize snapshots without delaying attachment writes behind text.
    const { result, payloadUnavailable } = await writeDurableComposerSnapshot(snapshot);
    if (payloadUnavailable) {
      reportDurableComposerStorageError(snapshot.scope, this.onStorageError);
    }
    if (result.status === "storage-failed" || result.status === "payload-too-large") {
      reportDurableComposerStorageError(snapshot.scope, this.onStorageError);
    } else if (result.status === "conflict") {
      this.resetRestoreScope();
      this.onConflict();
    }
  }

  async retire(scope: DurableComposerDraftScope, minimumRevision: number) {
    this.resetRestoreScope();
    const { retireDurableComposerDraft } = await durableComposerStore;
    const result = await retireDurableComposerDraft(scope, minimumRevision);
    if (result.status === "storage-failed") {
      reportDurableComposerStorageError(scope, this.onStorageError);
    }
  }

  restore(
    scope: DurableComposerDraftScope,
    prepare: () => Omit<RestoreBaseline, "scope"> & {
      onCurrentWins: (storedRevision: number) => void;
    },
    current: () => { scope: DurableComposerDraftScope | null; signature: string; revision: number },
    apply: (draft: RestoredDraft) => void,
  ) {
    const scopeIdentity = durableComposerScopeIdentity(scope);
    if (this.restoredScopeKey === scopeIdentity) {
      return;
    }
    // Capture edits before storage yields so a newer edit invalidates this baseline.
    const { onCurrentWins, ...baseline } = prepare();
    this.restoredScopeKey = scopeIdentity;
    const generation = ++this.restoreGeneration;
    void this.restoreScope({ scope, ...baseline }, generation, current, apply, onCurrentWins);
  }

  private async restoreScope(
    baseline: RestoreBaseline,
    generation: number,
    current: () => { scope: DurableComposerDraftScope | null; signature: string; revision: number },
    apply: (draft: RestoredDraft) => void,
    onCurrentWins: (storedRevision: number) => void,
  ) {
    const { readDurableComposerDraft, prepareDurableComposerRecovery } = await durableComposerStore;
    if (baseline.scope.scopeKey.startsWith("chat:v3:")) {
      const recovery = await prepareDurableComposerRecovery(baseline.scope);
      if (recovery.status === "storage-failed") {
        reportDurableComposerStorageError(baseline.scope, this.onStorageError);
        return;
      }
    }
    const result = await readDurableComposerDraft(baseline.scope);
    if (result.status === "storage-failed") {
      reportDurableComposerStorageError(baseline.scope, this.onStorageError);
      return;
    }
    const revision = result.status === "found" ? result.draft.revision : result.revision;
    if (revision === undefined || revision < baseline.latestRevision) {
      if (this.isBaselineCurrent(baseline, generation, current())) {
        onCurrentWins(revision ?? 0);
      }
      return;
    }
    const draft = result.status === "found" ? result.draft : undefined;
    let attachments: ChatAttachment[] = [];
    if (draft) {
      try {
        attachments = await hydrateDurableComposerAttachments(draft.attachments);
      } catch {
        reportDurableComposerStorageError(baseline.scope, this.onStorageError);
        return;
      }
    }
    if (!this.isBaselineCurrent(baseline, generation, current())) {
      return;
    }
    apply({
      revision,
      text: draft ? draft.text : "",
      ...(draft?.mentions ? { mentions: draft.mentions } : {}),
      ...(draft?.goalMode ? { goalMode: draft.goalMode } : {}),
      ...(draft?.replyTarget ? { replyTarget: draft.replyTarget } : {}),
      attachments,
    });
  }

  private isBaselineCurrent(
    baseline: RestoreBaseline,
    generation: number,
    active: { scope: DurableComposerDraftScope | null; signature: string; revision: number },
  ): boolean {
    return (
      generation === this.restoreGeneration &&
      active.scope?.gatewayOwner === baseline.scope.gatewayOwner &&
      active.scope.recoveryScope === baseline.scope.recoveryScope &&
      active.scope.scopeKey === baseline.scope.scopeKey &&
      active.signature === baseline.signature &&
      active.revision === baseline.latestRevision
    );
  }
}
