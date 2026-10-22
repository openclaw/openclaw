import type {
  DurableComposerDraftScope,
  DurableQuestionDraft,
} from "../../../lib/chat/composer-draft-store.runtime.ts";
import { nextDraftRevision } from "../../../lib/chat/outbox-store-draft-state.ts";
import type { AsyncQuestionDraft } from "./chat-async-question.types.ts";

// Presentation owns these drafts; this adapter only snapshots them into the
// existing composer store, whose authenticated scope and CAS fence every write.
export type AsyncQuestionDraftSession = {
  scope: DurableComposerDraftScope;
  drafts: Map<string, AsyncQuestionDraft>;
  resolved: ReadonlySet<string>;
  revision: number;
  writeId?: string;
  saved: string;
  attempted?: string;
  intentRevision?: number;
  loaded: boolean;
  invalidated?: boolean;
  load?: Promise<void>;
  write?: Promise<void>;
  error?: "storage" | "conflict";
  onChange: () => void;
};

const store = () => import("../../../lib/chat/composer-draft-store.runtime.ts");

function snapshot(session: AsyncQuestionDraftSession): DurableQuestionDraft[] {
  return [...session.drafts].flatMap(([itemId, draft]) =>
    !session.resolved.has(itemId) &&
    draft.signature &&
    (draft.edited || draft.reopenedAfterBoundary || draft.status === "skipped")
      ? [
          {
            itemId,
            signature: draft.signature,
            edited: draft.edited === true,
            ...(draft.status === "skipped" ? { dismissed: true } : {}),
            answers: [...draft.answers.values()].map((answer) => ({
              selected: [...answer.selected],
              freeText: answer.freeText,
            })),
            ...(draft.reopenedAfterBoundary
              ? { reopenedAfterBoundary: draft.reopenedAfterBoundary }
              : {}),
          },
        ]
      : [],
  );
}

export function restoreAsyncQuestionDrafts(session: AsyncQuestionDraftSession): void {
  if (session.load) {
    return;
  }
  session.load = (async () => {
    const result = await (await store()).readDurableComposerDraft(session.scope);
    if (result.status === "storage-failed") {
      session.error = "storage";
      session.onChange();
      return;
    }
    session.revision = result.status === "found" ? result.draft.revision : (result.revision ?? 0);
    session.writeId = result.status === "found" ? result.draft.writeId : result.writeId;
    if (
      result.status === "not-found" &&
      result.revision !== undefined &&
      result.revision >= (session.intentRevision ?? 0)
    ) {
      // Deletion/Incognito can retire this scope while its first read is pending.
      // A newer tombstone fences edits made before that retirement, not just writes
      // that had already observed the old row. Never mint a fresh revision for them.
      session.drafts.clear();
    }
    const stored = result.status === "found" ? (result.draft.questionDrafts ?? []) : [];
    session.saved = JSON.stringify(stored);
    for (const draft of stored) {
      const current = session.drafts.get(draft.itemId);
      const admitted = current?.status === "submitted" && current.admittedQueueId;
      // A user can type while storage opens. Hydration never replaces that newer intent,
      // and a reused item ID never inherits answers to a different question. An outbox
      // projection can precede hydration; restore its draft without retiring admission.
      if (
        session.resolved.has(draft.itemId) ||
        current?.edited ||
        (current?.status && !admitted) ||
        (current?.signature && current.signature !== draft.signature)
      ) {
        continue;
      }
      session.drafts.set(draft.itemId, {
        signature: draft.signature,
        edited: draft.edited,
        status: admitted ? "submitted" : draft.dismissed ? "skipped" : undefined,
        admittedQueueId: current?.admittedQueueId,
        answers: new Map(
          draft.answers.map((answer, index) => [
            String(index),
            {
              selected: new Set(answer.selected),
              freeText: answer.freeText,
            },
          ]),
        ),
        reopenedAfterBoundary: current?.reopenedAfterBoundary ?? draft.reopenedAfterBoundary,
      });
    }
    session.loaded = true;
    session.onChange();
  })().catch(() => {
    session.error = "storage";
    session.onChange();
  });
}

export function persistAsyncQuestionDrafts(
  session: AsyncQuestionDraftSession,
  newIntent = false,
): void {
  if (newIntent) {
    session.intentRevision = nextDraftRevision(session.intentRevision);
  }
  session.write = (session.write ?? Promise.resolve())
    .then(async () => {
      await session.load;
      if (!session.loaded || session.invalidated) {
        return;
      }
      const questionDrafts = snapshot(session);
      const signature = JSON.stringify(questionDrafts);
      if (signature === session.saved || signature === session.attempted) {
        return;
      }
      // A failed snapshot stays visible but must not reschedule itself on every render.
      // Only changed user/history intent may attempt a different snapshot.
      session.attempted = signature;
      const revision = nextDraftRevision(session.revision);
      const writeId = `question:${crypto.randomUUID()}`;
      const owner = await store();
      if (session.invalidated) {
        return;
      }
      const result = await owner.writeDurableComposerDraft(
        session.scope,
        { revision, text: "", attachments: [], questionDrafts },
        { expectedRevision: session.revision, expectedWriteId: session.writeId, writeId },
      );
      if (result.status === "persisted") {
        session.revision = revision;
        session.writeId = writeId;
        session.saved = signature;
        session.error = undefined;
      } else {
        session.error = result.status === "conflict" ? "conflict" : "storage";
      }
      session.onChange();
    })
    .catch(() => {
      session.error = "storage";
      session.onChange();
    });
}
