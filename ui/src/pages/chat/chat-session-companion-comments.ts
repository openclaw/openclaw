import type {
  ChatSelectionAnnotation,
  DurableComposerDraftScope,
} from "../../lib/chat/chat-types.ts";
import { nextDraftRevision } from "../../lib/chat/outbox-store-draft-state.ts";

const store = () => import("../../lib/chat/composer-draft-store.runtime.ts");

/** Persists private, unsent comment metadata through the existing draft owner. */
export class ChatSessionCompanionComments {
  private revision = 0;
  private writeId: string | undefined;
  private saved = "[]";
  private intentRevision = 0;
  private retiredIntentRevision = 0;
  private loaded = false;
  private failed = false;
  private invalidated = false;
  private write = Promise.resolve();
  readonly restoration: Promise<void>;

  constructor(
    readonly scope: DurableComposerDraftScope,
    private readonly isCurrent: () => boolean,
    private readonly restore: (comments: ChatSelectionAnnotation[]) => void,
    private readonly onError: () => void,
  ) {
    this.restoration = this.read().catch(() => this.reportError());
  }

  dispose() {
    this.invalidated = true;
  }

  get editRevision() {
    return this.intentRevision;
  }

  get ready(): boolean {
    // A reported read failure leaves the pane usable in memory. Writes still
    // require a loaded durable revision, and owner replacement always fences input.
    return (this.loaded || this.failed) && this.current();
  }

  private current() {
    return !this.invalidated && this.isCurrent();
  }

  private reportError() {
    if (this.current() && !this.failed) {
      this.failed = true;
      this.onError();
    }
  }

  private async read() {
    const result = await (await store()).readDurableComposerDraft(this.scope);
    if (!this.current()) {
      return;
    }
    if (result.status === "storage-failed") {
      this.reportError();
      return;
    }
    this.revision = result.status === "found" ? result.draft.revision : (result.revision ?? 0);
    this.writeId = result.status === "found" ? result.draft.writeId : result.writeId;
    const comments = result.status === "found" ? (result.draft.selectionAnnotations ?? []) : [];
    this.saved = JSON.stringify(comments);
    this.loaded = true;
    // Edits made while IndexedDB opens win over an older saved snapshot. A
    // deletion/Incognito tombstone still fences intent predating retirement.
    if (
      result.status === "not-found" &&
      this.revision >= this.intentRevision &&
      this.intentRevision
    ) {
      this.retiredIntentRevision = this.revision;
      this.restore([]);
    } else if (!this.intentRevision) {
      this.restore(comments);
    }
  }

  save(comments: ChatSelectionAnnotation[]) {
    const intentRevision = nextDraftRevision(Math.max(this.intentRevision, this.revision));
    this.intentRevision = intentRevision;
    const signature = JSON.stringify(comments);
    this.write = this.write
      .then(async () => {
        await this.restoration;
        if (
          !this.loaded ||
          !this.current() ||
          intentRevision <= this.retiredIntentRevision ||
          signature === this.saved
        ) {
          return;
        }
        const owner = await store();
        if (!this.current()) {
          return;
        }
        const revision = nextDraftRevision(this.revision);
        const writeId = `comment:${crypto.randomUUID()}`;
        const result = await owner.writeDurableComposerDraft(
          this.scope,
          { revision, text: "", attachments: [], selectionAnnotations: comments },
          { expectedRevision: this.revision, expectedWriteId: this.writeId, writeId },
        );
        if (result.status === "persisted") {
          this.revision = revision;
          this.writeId = writeId;
          this.saved = signature;
        } else {
          // A competing pane's edit remains authoritative; keep this draft in
          // memory and surface the conflict instead of silently overwriting it.
          this.reportError();
        }
      })
      .catch(() => this.reportError());
  }
}
