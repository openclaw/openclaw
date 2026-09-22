import { formatUiError } from "../../../lib/format-error.ts";
import { readFileDraft } from "./chat-file-drafts.ts";
import {
  clearSessionWorkspaceError,
  setSessionWorkspaceError,
  isCurrentSessionWorkspace,
  openSessionWorkspacePreview,
  requestWorkspaceUpdate,
} from "./chat-session-workspace-state.ts";
import type {
  SessionWorkspaceHost,
  SessionWorkspaceState,
  SessionWorkspacePreview,
} from "./chat-session-workspace-types.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

type PreviewRead = { order: number; published?: ReturnType<typeof capturePreview> };
const previewReads = new WeakMap<SessionWorkspacePreview, PreviewRead>();
let nextReadOrder = 0;

export function openWorkspaceItem<T>(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  itemId: string,
  load: () => Promise<T | null | undefined>,
  render: (result: T) => SidebarContent | null,
  missingMessage: string,
  options: {
    line?: number | null;
    revalidate?: boolean;
    label: string;
    resolveLabel?: (result: T) => string | undefined;
    resolveKey?: (result: T) => string | undefined;
  },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const request = {
    kind: "loading",
    fileTab: {
      id: itemId,
      label: options.label,
    },
  } as const;
  const preview = openSessionWorkspacePreview(state, itemId, request.fileTab.label, request);
  const selectionId = preview.canonicalKey ?? itemId;
  workspace.activeId = selectionId;
  if (options.line != null) {
    preview.navigation = { line: options.line };
    workspace.navigationOrder = (workspace.navigationOrder ?? 0) + 1;
    preview.navigationOrder = workspace.navigationOrder;
    if (preview.content.kind === "file") {
      preview.content.navigation = preview.navigation;
    }
    workspace.previews = [...workspace.previews];
  }
  // Reopening an unavailable file retries its read without creating another tab.
  if (preview.content.kind === "unavailable") {
    preview.content = request;
    workspace.previews = [...workspace.previews];
  }
  state.handleOpenSidebar(request);
  const previous = preview.content;
  if (
    previous !== request &&
    (!options.revalidate ||
      previous.kind === "loading" ||
      (previous.kind === "file" && readFileDraft(previous)))
  ) {
    return;
  }
  const read: PreviewRead = { order: ++nextReadOrder };
  previewReads.set(preview, read);
  const requested = capturePreview(preview);
  const candidates = new Map(
    workspace.previews.map((entry) => {
      const currentRead = previewReads.get(entry);
      return [
        entry,
        { snapshot: capturePreview(entry), read: currentRead, published: currentRead?.published },
      ];
    }),
  );
  const isCurrent = () =>
    workspace.previews.includes(preview) &&
    previewReads.get(preview) === read &&
    canReplacePreview(preview, requested) &&
    isCurrentSessionWorkspace(state, workspace);
  const fail = (message: string) => {
    if (!isCurrent()) {
      return;
    }
    setSessionWorkspaceError(workspace, message, read);
    const unavailable = { kind: "unavailable" as const, message };
    preview.content = unavailable;
    read.published = capturePreview(preview);
    workspace.previews = [...workspace.previews];
  };
  void (async () => {
    setSessionWorkspaceError(workspace, null);
    try {
      const result = await load();
      const content = result == null ? null : render(result);
      const label = result == null ? undefined : options.resolveLabel?.(result);
      const canonicalKey = result == null ? undefined : options.resolveKey?.(result);
      if (!content) {
        fail(missingMessage);
        return;
      }
      if (isCurrent()) {
        if (workspace.activeId === selectionId && canonicalKey) {
          workspace.activeId = canonicalKey;
        }
        const canonical = canonicalKey
          ? workspace.previews.find(
              (entry) => entry !== preview && entry.canonicalKey === canonicalKey,
            )
          : undefined;
        if (canonical) {
          canonical.requestIds = [
            ...new Set([
              ...(canonical.requestIds ?? []),
              preview.id,
              ...(preview.requestIds ?? []),
            ]),
          ];
          if (
            preview.navigation &&
            (preview.navigationOrder ?? 0) > (canonical.navigationOrder ?? 0)
          ) {
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
            options.revalidate &&
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
          }
          workspace.previews = workspace.previews.filter((entry) => entry !== preview);
          if (workspace.activePreviewId === preview.id) {
            workspace.activePreviewId = canonical.id;
          }
          return;
        }
        preview.canonicalKey = canonicalKey;
        updatePreviewContent(preview, content, label);
        read.published = capturePreview(preview);
        workspace.previews = [...workspace.previews];
      }
    } catch (error) {
      fail(formatUiError(error));
    } finally {
      requestWorkspaceUpdate(state);
    }
  })();
}

function capturePreview(preview: SessionWorkspacePreview) {
  const content = preview.content;
  return {
    content,
    text: content.kind === "file" ? content.content : undefined,
    hash: content.kind === "file" ? content.edit?.hash : undefined,
  };
}

function canReplacePreview(
  preview: SessionWorkspacePreview,
  captured: ReturnType<typeof capturePreview> | undefined,
) {
  const content = preview.content;
  return (
    captured !== undefined &&
    content === captured.content &&
    (content.kind !== "file" ||
      (!readFileDraft(content) &&
        content.content === captured.text &&
        content.edit?.hash === captured.hash))
  );
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
      previous.path === content.path &&
      previous.root === content.root &&
      previous.mimeType === content.mimeType
    )
  ) {
    preview.content = content;
  }
  preview.label = label || preview.label;
}
