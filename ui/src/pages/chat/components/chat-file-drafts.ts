import { registerControlUiReloadGuard } from "../../../app/document-reload-guard.ts";
import { t } from "../../../i18n/index.ts";
import { showToast } from "../../../lib/toast.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

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
