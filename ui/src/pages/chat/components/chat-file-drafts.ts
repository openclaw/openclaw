import { registerControlUiReloadGuard } from "../../../app/document-reload-guard.ts";
import { t } from "../../../i18n/index.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { showToast } from "../../../lib/toast.ts";
import type { FileSidebarContent } from "./chat-sidebar-content-types.ts";
import { reviewFileDrafts } from "./file-draft-recovery-dialog.ts";

registerFilePreviewEnglish();

type RetainedFileDraft = {
  content: string;
  expectedHash: string;
};

const retainedFileDrafts = new Map<
  string,
  {
    draft: RetainedFileDraft;
    name: string;
    path: string;
    context: FileSidebarContent["draftContext"];
  }
>();
let stopReloadGuard: (() => void) | undefined;
let reviewingDrafts = false;

async function reviewRetainedFileDrafts() {
  if (reviewingDrafts || retainedFileDrafts.size === 0) {
    return;
  }
  reviewingDrafts = true;
  try {
    await reviewFileDrafts(
      [...retainedFileDrafts].map(([key, record]) => ({
        name: record.name,
        path: record.path,
        context: record.context,
        content: record.draft.content,
        isCurrent: () => retainedFileDrafts.get(key) === record,
        discard: () => {
          if (retainedFileDrafts.get(key) !== record) {
            return false;
          }
          retainedFileDrafts.delete(key);
          syncReloadGuard();
          return true;
        },
      })),
    );
  } finally {
    reviewingDrafts = false;
  }
}

function retainedFileDraftKey(content: FileSidebarContent): string {
  return content.draftKey ?? `${content.root ?? ""}\u0000${content.path}`;
}

export function readFileDraft(content: FileSidebarContent): RetainedFileDraft | undefined {
  return retainedFileDrafts.get(retainedFileDraftKey(content))?.draft;
}

export function restoreFileDraft(
  content: FileSidebarContent | null,
): RetainedFileDraft | undefined {
  if (!content?.edit) {
    return undefined;
  }
  const draft = readFileDraft(content);
  if (draft?.content === content.content) {
    setFileDraft(content, null);
    return undefined;
  }
  return draft;
}

export function captureFileEditorDraft(
  content: FileSidebarContent,
  edit: { editing: boolean; content: string; dirty: boolean; expectedHash: string },
): { dirty: boolean; expectedHash: string } | null {
  // Read-only rendering may normalize line endings; only edits own drafts.
  if (!edit.editing) {
    return null;
  }
  const { dirty } = edit;
  const expectedHash = dirty ? edit.expectedHash : (content.edit?.hash ?? "");
  setFileDraft(content, dirty ? { content: edit.content, expectedHash } : null);
  return { dirty, expectedHash };
}

export function setFileDraft(content: FileSidebarContent, draft: RetainedFileDraft | null) {
  const key = retainedFileDraftKey(content);
  retainedFileDrafts.delete(key);
  if (draft) {
    retainedFileDrafts.set(key, {
      draft,
      name: content.name,
      path: content.path,
      context: content.draftContext,
    });
  }
  syncReloadGuard();
}

function syncReloadGuard() {
  // Closed previews still own drafts; protection lasts until the last draft settles.
  if (retainedFileDrafts.size > 0) {
    stopReloadGuard ??= registerControlUiReloadGuard(
      () => retainedFileDrafts.size === 0,
      () =>
        showToast({
          message: t("chat.detailPanel.reloadBlocked"),
          actionLabel: t("chat.detailPanel.draftRecovery.review"),
          onAction: () => void reviewRetainedFileDrafts(),
        }),
    );
  } else {
    stopReloadGuard?.();
    stopReloadGuard = undefined;
  }
}
