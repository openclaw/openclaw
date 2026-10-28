import { toErrorObject } from "@openclaw/normalization-core";
import { formatUiError } from "../../../lib/format-error.ts";
import { readFileDraft } from "./chat-file-drafts.ts";
import {
  captureSessionWorkspaceNavigation,
  setSessionWorkspaceError,
  isCurrentSessionWorkspace,
  openSessionWorkspacePreview,
  sessionWorkspaceForHost,
} from "./chat-session-workspace-state.ts";
import type {
  SessionWorkspaceHost,
  SessionWorkspaceState,
} from "./chat-session-workspace-types.ts";
import type { SessionWorkspacePreview, SidebarContent } from "./chat-sidebar-content-types.ts";

export type PreviewRead = {
  order: number;
  published?: ReturnType<typeof capturePreview>;
  settled?: Promise<SessionWorkspacePreview | undefined>;
};
const previewReads = new WeakMap<SessionWorkspacePreview, PreviewRead>();
let nextReadOrder = 0;

export function openWorkspaceItem<T>(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  itemId: string,
  load: (signal: AbortSignal) => Promise<T | null | undefined>,
  render: (result: T) => SidebarContent | null,
  missingMessage: string,
  options: {
    disposition?: "pinned" | "preview";
    intent?: "navigate";
    line?: number | null;
    revalidate?: boolean;
    label: string;
    resolveLabel?: (result: T) => string | undefined;
    resolveKey?: (result: T) => string | undefined;
    resolveError?: (error: unknown) => string | undefined;
  },
): Promise<SessionWorkspacePreview | undefined> | undefined {
  if (!state.client || !state.connected) {
    return undefined;
  }
  const intent = { id: itemId, disposition: options.disposition ?? ("pinned" as const) };
  const navigation = options.disposition ? captureSessionWorkspaceNavigation(workspace) : undefined;
  const known = workspace.previews.find(
    (entry) =>
      entry.id === itemId || entry.canonicalKey === itemId || entry.requestIds?.includes(itemId),
  );
  if (options.disposition && workspace.pendingPreview?.id === itemId) {
    if (options.disposition === "pinned") {
      workspace.pendingPreview.disposition = "pinned";
    }
    return undefined;
  }
  const read: PreviewRead = { order: ++nextReadOrder };
  const candidates = new Map(
    workspace.previews.map((entry) => {
      const currentRead = previewReads.get(entry);
      return [
        entry,
        { snapshot: capturePreview(entry), read: currentRead, published: currentRead?.published },
      ];
    }),
  );
  // Unknown aliases resolve through the existing authorized loader before any temporary tab retires.
  const begin = (readResult: typeof load, resolvedKey?: string) => {
    const request = {
      kind: "loading",
      fileTab: {
        id: itemId,
        label: options.label,
        disposition: intent.disposition,
        intent: options.intent,
      },
    } as const;
    const preview = openSessionWorkspacePreview(
      state,
      itemId,
      request.fileTab.label,
      request,
      intent.disposition,
      {
        canonicalKey: resolvedKey,
        navigation,
        replaceTemporary: options.disposition === "preview",
      },
    );
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
    sessionWorkspaceForHost(state).publish();
    const previous = preview.content;
    if (
      previous !== request &&
      (!options.revalidate ||
        previous.kind === "loading" ||
        (previous.kind === "file" && readFileDraft(previous)))
    ) {
      return previous.kind === "loading"
        ? previewReads.get(preview)?.settled
        : Promise.resolve(preview);
    }
    previewReads.set(preview, read);
    const requested =
      previous === request
        ? capturePreview(preview)
        : (candidates.get(preview)?.snapshot ?? capturePreview(preview));
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
      preview.content = { kind: "unavailable", message };
      read.published = capturePreview(preview);
      workspace.previews = [...workspace.previews];
    };
    const controller = new AbortController();
    const stopWatching = sessionWorkspaceForHost(state).subscribe(() => {
      if (!isCurrent()) {
        controller.abort();
      }
    });
    read.settled = (async () => {
      setSessionWorkspaceError(workspace, null);
      try {
        const resultPromise = readResult(controller.signal);
        const [result, applyPreview] = await Promise.all([
          resultPromise,
          import("./chat-session-workspace-preview.runtime.ts").then(
            ({ applyWorkspacePreview }) => applyWorkspacePreview,
          ),
        ]);
        const content = result == null ? null : render(result);
        const label = result == null ? undefined : options.resolveLabel?.(result);
        const canonicalKey = result == null ? undefined : options.resolveKey?.(result);
        if (!content) {
          fail(missingMessage);
          return undefined;
        }
        if (isCurrent()) {
          return applyPreview({
            workspace,
            preview,
            read,
            previewReads,
            candidates,
            selectionId,
            canonicalKey,
            content,
            label,
            revalidate: options.revalidate,
          });
        }
      } catch (error) {
        fail(options.resolveError?.(error) ?? formatUiError(error));
      } finally {
        stopWatching();
        if (isCurrentSessionWorkspace(state, workspace)) {
          sessionWorkspaceForHost(state).publish();
        }
      }
      return undefined;
    })();
    preview.readResult = read.settled;
    sessionWorkspaceForHost(state).publish();
    return read.settled;
  };
  if (options.disposition && !known) {
    workspace.pendingPreview = intent;
    workspace.activeId = itemId;
    setSessionWorkspaceError(workspace, null);
    sessionWorkspaceForHost(state).publish();
    const controller = new AbortController();
    const stopWatching = sessionWorkspaceForHost(state).subscribe(() => {
      if (workspace.pendingPreview !== intent || !isCurrentSessionWorkspace(state, workspace)) {
        controller.abort();
      }
    });
    return (async () => {
      try {
        const result = await load(controller.signal);
        if (workspace.pendingPreview !== intent || !isCurrentSessionWorkspace(state, workspace)) {
          return undefined;
        }
        return begin(
          () => Promise.resolve(result),
          result == null ? undefined : options.resolveKey?.(result),
        );
      } catch (error) {
        if (workspace.pendingPreview !== intent || !isCurrentSessionWorkspace(state, workspace)) {
          return undefined;
        }
        return begin(() => Promise.reject(toErrorObject(error, formatUiError(error))));
      } finally {
        stopWatching();
        if (workspace.pendingPreview === intent) {
          workspace.pendingPreview = undefined;
        }
      }
    })();
  }
  workspace.pendingPreview = undefined;
  return begin(load);
}

export function capturePreview(preview: SessionWorkspacePreview) {
  const content = preview.content;
  return {
    content,
    text: content.kind === "file" ? content.content : undefined,
    hash: content.kind === "file" ? content.edit?.hash : undefined,
  };
}

export function canReplacePreview(
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
