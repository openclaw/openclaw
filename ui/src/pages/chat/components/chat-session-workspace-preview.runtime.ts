import {
  canReplacePreview,
  capturePreview,
  type PreviewRead,
} from "./chat-session-workspace-preview.ts";
import { clearSessionWorkspaceError } from "./chat-session-workspace-state.ts";
import type { SessionWorkspaceState } from "./chat-session-workspace-types.ts";
import type { SessionWorkspacePreview, SidebarContent } from "./chat-sidebar-content-types.ts";

export function applyWorkspacePreview({
  workspace,
  preview,
  read,
  previewReads,
  candidates,
  selectionId,
  canonicalKey,
  content,
  label,
  revalidate,
}: {
  workspace: SessionWorkspaceState;
  preview: SessionWorkspacePreview;
  read: PreviewRead;
  previewReads: WeakMap<SessionWorkspacePreview, PreviewRead>;
  candidates: Map<
    SessionWorkspacePreview,
    {
      snapshot: ReturnType<typeof capturePreview>;
      read: PreviewRead | undefined;
      published: ReturnType<typeof capturePreview> | undefined;
    }
  >;
  selectionId: string;
  canonicalKey: string | undefined;
  content: SidebarContent;
  label: string | undefined;
  revalidate: boolean | undefined;
}): SessionWorkspacePreview {
  if (workspace.activeId === selectionId && canonicalKey) {
    workspace.activeId = canonicalKey;
  }
  const canonical = canonicalKey
    ? workspace.previews.find((entry) => entry !== preview && entry.canonicalKey === canonicalKey)
    : undefined;
  if (canonical) {
    canonical.requestIds = [
      ...new Set([...(canonical.requestIds ?? []), preview.id, ...(preview.requestIds ?? [])]),
    ];
    if (preview.navigation && (preview.navigationOrder ?? 0) > (canonical.navigationOrder ?? 0)) {
      canonical.navigation = preview.navigation;
      canonical.navigationOrder = preview.navigationOrder;
      if (canonical.content.kind === "file") {
        canonical.content.navigation = canonical.navigation;
      }
    }
    const captured = candidates.get(canonical);
    const currentRead = previewReads.get(canonical);
    const snapshot =
      currentRead === captured?.read && currentRead?.published === captured?.published
        ? captured?.snapshot
        : currentRead?.published;
    if (
      revalidate &&
      (currentRead?.order ?? 0) <= read.order &&
      canReplacePreview(canonical, snapshot)
    ) {
      updatePreviewContent(canonical, content, label);
      if (currentRead) {
        clearSessionWorkspaceError(workspace, currentRead);
      }
      // Even unchanged bytes settle newer intent and retire older alias reads.
      read.published = capturePreview(canonical);
      previewReads.set(canonical, read);
      canonical.readResult = read.settled;
    }
    if (preview.pinned === true) {
      canonical.pinned = true;
    }
    workspace.previews = workspace.previews.filter((entry) => entry !== preview);
    if (workspace.activePreviewId === preview.id) {
      canonical.catalogNavigation = preview.catalogNavigation ?? canonical.catalogNavigation;
      workspace.activePreviewId = canonical.id;
    }
    return canonical;
  }
  preview.canonicalKey = canonicalKey;
  updatePreviewContent(preview, content, label);
  read.published = capturePreview(preview);
  workspace.previews = [...workspace.previews];
  return preview;
}

function updatePreviewContent(
  preview: SessionWorkspacePreview,
  content: SidebarContent,
  label: string | undefined,
) {
  const previous = preview.content;
  if (content.kind === "file" && preview.navigation) {
    content.line = preview.navigation.line;
    content.navigation = preview.navigation;
  }
  // A confirming read must preserve the mounted editor, cursor, and undo history.
  if (
    !(
      previous.kind === "file" &&
      content.kind === "file" &&
      previous.content === content.content &&
      previous.edit?.hash === content.edit?.hash &&
      previous.draftKey === content.draftKey &&
      previous.path === content.path &&
      previous.root === content.root &&
      previous.mimeType === content.mimeType
    )
  ) {
    preview.content = content;
  }
  preview.label = label || preview.label;
}
