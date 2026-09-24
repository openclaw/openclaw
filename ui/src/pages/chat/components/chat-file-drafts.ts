import { registerControlUiReloadGuard } from "../../../app/document-reload-guard.ts";
import { t } from "../../../i18n/index.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { showToast } from "../../../lib/toast.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

registerFilePreviewEnglish();

type FileSidebarContent = Extract<SidebarContent, { kind: "file" }>;

type RetainedFileDraft = {
  content: string;
  expectedHash: string;
};

const retainedFileDrafts = new Map<string, RetainedFileDraft>();
let stopReloadGuard: (() => void) | undefined;

function retainedFileDraftKey(content: FileSidebarContent): string {
  return content.draftKey ?? `${content.root ?? ""}\u0000${content.path}`;
}

export function readFileDraft(content: FileSidebarContent): RetainedFileDraft | undefined {
  return retainedFileDrafts.get(retainedFileDraftKey(content));
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
    retainedFileDrafts.set(key, draft);
  }
  // Closed previews still own drafts; protection lasts until the last draft settles.
  if (retainedFileDrafts.size > 0) {
    stopReloadGuard ??= registerControlUiReloadGuard(
      () => retainedFileDrafts.size === 0,
      () => showToast({ message: t("chat.detailPanel.reloadBlocked") }),
    );
  } else {
    stopReloadGuard?.();
    stopReloadGuard = undefined;
  }
}
