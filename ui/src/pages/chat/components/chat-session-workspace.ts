import { BROWSER_IMAGE_MIME_TYPES } from "../../../../../src/shared/browser-image-mime-types.js";
import { downloadArtifact } from "../../../api/artifact-download.ts";
import { GatewayRequestError } from "../../../api/gateway.ts";
import { downloadSessionFile } from "../../../api/session-file-download.ts";
import type { SessionWorkspaceGetResult } from "../../../api/types.ts";
import { hasOperatorAdminAccess } from "../../../app/operator-access.ts";
import type { MarkdownFileLinkTarget } from "../../../components/markdown-file-links.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { base64ToBytes } from "../../../lib/bytes-base64.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../../lib/gateway-methods.ts";
import { pathDisplayName } from "../../../lib/path-display.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import { parseAgentSessionKey } from "../../../lib/sessions/session-key.ts";
import { sessionWorkspaceFileKey } from "../../../lib/sessions/workspace.ts";
import { resolveSessionWorkspaceDiff } from "./chat-session-workspace-diff.ts";
import {
  hasUniformLineEndings,
  loadArtifactSidebarContent,
  readWorkspaceFileText,
  unsupportedFileSidebarContent,
} from "./chat-session-workspace-file-content.ts";
import { openWorkspaceItem } from "./chat-session-workspace-preview.ts";
import {
  captureSessionWorkspaceNavigation,
  loadSessionWorkspaceDirectory,
  clearWorkspaceTimer,
  getSessionWorkspace,
  isCurrentSessionWorkspace,
  loadSessionWorkspace,
  refreshSessionWorkspaceState,
  sessionWorkspaceForHost,
} from "./chat-session-workspace-state.ts";
import type {
  SessionWorkspaceHost,
  SessionWorkspaceState,
} from "./chat-session-workspace-types.ts";
import type {
  FileReaderView,
  SessionWorkspaceFilter,
  SessionWorkspaceMobileNavigation,
  SidebarContent,
  TranscriptAttachments,
} from "./chat-sidebar-content-types.ts";

registerChatSessionEnglish();

registerFilePreviewEnglish();

export { retireSessionWorkspaceCheckout } from "./chat-session-workspace-state.ts";
export type { SessionWorkspaceHost } from "./chat-session-workspace-types.ts";

function workspaceBrowserFilePath(root: string | undefined, filePath: string): string {
  if (!root || /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(filePath)) {
    return filePath;
  }
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  const relative = filePath.replace(/^[\\/]+/, "").replaceAll(/[\\/]/g, separator);
  return base ? `${base}${separator}${relative}` : `${separator}${relative}`;
}

export function refreshSessionWorkspace(state: SessionWorkspaceHost, refreshFiles: boolean) {
  if (refreshSessionWorkspaceState(state, refreshFiles)) {
    state.sidebarContent = resolveSessionDiffSidebarContent(state);
    sessionWorkspaceForHost(state).publish();
  }
}

function openFile(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  path: string,
  opts: {
    line?: number | null;
    requestPath?: string;
    sessionKey?: string;
    disposition?: "pinned" | "preview";
    intent?: "navigate";
    messageEntryId?: string;
  } = {},
) {
  const requestPath = opts.requestPath ?? path;
  const sessionKey = opts.sessionKey ?? workspace.sessionKey;
  const agentId = opts.sessionKey
    ? parseAgentSessionKey(opts.sessionKey)?.agentId
    : workspace.agentId;
  const viewingSession = sessionKey === workspace.sessionKey;
  // A message-qualified read selects that message's original files, read-only.
  const messageFile = opts.messageEntryId ? { messageEntryId: opts.messageEntryId } : {};
  const draftScope = state.sessionWorkspaceDraftScope;
  const draftContext = state.sessionWorkspaceDraftContext;
  const gatewayUrl = state.settings?.gatewayUrl ?? "";
  return openWorkspaceItem(
    state,
    workspace,
    viewingSession && !opts.messageEntryId
      ? `file:${requestPath}`
      : JSON.stringify(["file", sessionKey, requestPath, opts.messageEntryId]),
    async () => {
      try {
        return await state.sessions.getFile(sessionKey, requestPath, { agentId, ...messageFile });
      } catch (error) {
        const details = error instanceof GatewayRequestError ? error.details : null;
        if (
          details &&
          typeof details === "object" &&
          "type" in details &&
          details.type === "session_file_too_large" &&
          "size" in details &&
          typeof details.size === "number"
        ) {
          // The authorized read supplies metadata even when its preview bytes are unavailable.
          const metadata: SessionWorkspaceGetResult = {
            sessionKey,
            file: {
              path: requestPath,
              name: pathDisplayName(path),
              size: details.size,
              kind: "read",
              missing: false,
              previewKind: "unsupported",
            },
          };
          return metadata;
        }
        throw error;
      }
    },
    (result) => {
      const file = result.file;
      if (!file) {
        return null;
      }
      const name = file.name || pathDisplayName(path);
      const filePath = file.workspacePath || file.path || path;
      const download = (signal: AbortSignal) =>
        downloadSessionFile(
          state,
          { sessionKey: result.sessionKey, agentId, path: requestPath, ...messageFile },
          signal,
        );
      if (file.previewKind === "image") {
        if (
          file.contentEncoding !== "base64" ||
          typeof file.content !== "string" ||
          !file.mimeType ||
          !BROWSER_IMAGE_MIME_TYPES.has(file.mimeType)
        ) {
          return null;
        }
        return {
          kind: "image",
          title: name,
          src: `data:${file.mimeType};base64,${file.content}`,
          mimeType: file.mimeType,
          rawText: filePath,
          file: {
            path: filePath,
            absolutePath: workspaceBrowserFilePath(result.root, filePath),
            root: result.root,
            download,
          },
        };
      }
      if (file.previewKind === "unsupported") {
        return {
          ...unsupportedFileSidebarContent(file, path, download),
          fileLinkSessionKey: result.sessionKey,
          file: {
            path: filePath,
            absolutePath: workspaceBrowserFilePath(result.root, filePath),
            root: result.root,
            download,
          },
        };
      }
      const text = readWorkspaceFileText(file);
      if (text === null) {
        return null;
      }
      const canEdit =
        typeof file.hash === "string" &&
        hasUniformLineEndings(text) &&
        isGatewayMethodAdvertised(state, "sessions.files.set") === true &&
        hasOperatorAdminAccess(state.hello?.auth ?? null);
      const edit = canEdit
        ? {
            hash: file.hash!,
            save: async ({ content, expectedHash }: { content: string; expectedHash: string }) => {
              try {
                const saved = await state.sessions.setFile(
                  result.sessionKey,
                  requestPath,
                  content,
                  {
                    agentId,
                    expectedHash,
                    ...(result.source ? { expectedSource: result.source } : {}),
                  },
                );
                const hash = saved?.file.hash;
                if (
                  typeof hash === "string" &&
                  viewingSession &&
                  isCurrentSessionWorkspace(state, workspace)
                ) {
                  refreshSessionWorkspace(state, true);
                }
                return typeof hash === "string"
                  ? {
                      ok: true as const,
                      hash,
                    }
                  : { ok: false as const, code: "error" as const, message: "Save failed." };
              } catch (error) {
                const details =
                  error instanceof GatewayRequestError &&
                  error.details &&
                  typeof error.details === "object"
                    ? (error.details as { type?: unknown })
                    : null;
                if (
                  details?.type === "session_file_source_changed" &&
                  viewingSession &&
                  isCurrentSessionWorkspace(state, workspace)
                ) {
                  // Reopened browser rows must use the current root, without replacing this draft.
                  loadSessionWorkspace(state, workspace, true);
                }
                if (details?.type === "session_file_conflict") {
                  return {
                    ok: false as const,
                    code: "conflict" as const,
                  };
                }
                return {
                  ok: false as const,
                  code: "error" as const,
                  message: formatUiError(error),
                };
              }
            },
            fetchLatest: async () => {
              const latest = await state.sessions.getFile(result.sessionKey, requestPath, {
                agentId,
                ...messageFile,
              });
              // A hash-conflict recovery still belongs to the file source that was opened.
              if (
                latest?.source?.workspaceId !== result.source?.workspaceId ||
                latest?.source?.root !== result.source?.root ||
                latest?.source?.fileRoot !== result.source?.fileRoot
              ) {
                return null;
              }
              const latestFile = latest?.file;
              if (
                !latestFile ||
                typeof latestFile.content !== "string" ||
                typeof latestFile.hash !== "string"
              ) {
                return null;
              }
              return {
                content: latestFile.content,
                hash: latestFile.hash,
                // Reloaded content re-passes the uniform-endings gate so a
                // conflict reload cannot smuggle mixed endings into edit mode.
                editable: hasUniformLineEndings(latestFile.content),
              };
            },
          }
        : undefined;
      const extension = name.match(/\.([a-z0-9_-]+)$/i)?.[1]?.toLowerCase() ?? "";
      return {
        kind: "file",
        path: filePath,
        absolutePath: workspaceBrowserFilePath(result.root, filePath),
        name,
        content: text,
        download,
        sessionFileSource: {
          sessionKey: result.sessionKey,
          agentId,
          path: filePath,
          ...messageFile,
        },
        draftKey: [
          gatewayUrl,
          draftScope ?? "",
          result.sessionKey,
          result.root ?? "",
          filePath,
          ...(result.source
            ? [result.source.workspaceId, result.source.root ?? "", result.source.fileRoot ?? ""]
            : []),
        ].join("\u0000"),
        draftContext: {
          sessionKey: result.sessionKey,
          sessionTitle:
            (viewingSession ? draftContext?.sessionTitle : undefined) ??
            resolveSessionDisplayName(result.sessionKey),
          paneLabel: draftContext?.paneLabel,
        },
        root: result.root ?? null,
        mimeType: file.mimeType,
        language: extension === "yml" ? "yaml" : extension,
        line: opts.line ?? null,
        rawText: text,
        ...(edit ? { edit } : {}),
      };
    },
    `Failed to load ${path}`,
    {
      line: opts.line,
      disposition: opts.disposition,
      intent: opts.intent,
      label: pathDisplayName(path),
      revalidate: true,
      resolveLabel: (result) => result.file?.name,
      resolveKey: (result) => {
        const canonicalPath = result.file?.workspacePath || result.file?.path;
        return canonicalPath
          ? sessionWorkspaceFileKey(result.sessionKey, result.root, canonicalPath)
          : undefined;
      },
      resolveError: (error) =>
        error instanceof GatewayRequestError &&
        typeof error.details === "object" &&
        error.details !== null &&
        "reason" in error.details &&
        error.details.reason === "outside_session_boundary"
          ? t("chat.detailPanel.outsideSessionBoundary", {
              session:
                (viewingSession ? draftContext?.sessionTitle : undefined) ??
                resolveSessionDisplayName(sessionKey),
            })
          : undefined,
    },
  );
}

export function openSessionWorkspaceFile(
  state: SessionWorkspaceHost,
  target: MarkdownFileLinkTarget,
  disposition?: "pinned" | "preview",
) {
  return openFile(state, getSessionWorkspace(state), target.path, {
    line: target.line,
    sessionKey: target.sessionKey,
    disposition,
    messageEntryId: target.messageEntryId,
  });
}

/** Deliver a mode only to the exact retained preview settled by this native open. */
export async function openSessionWorkspaceFileView(
  state: SessionWorkspaceHost,
  path: string,
  view: FileReaderView,
) {
  const workspace = getSessionWorkspace(state);
  const client = state.client;
  const epoch = state.connectionEpoch;
  const order = (workspace.navigationOrder = (workspace.navigationOrder ?? 0) + 1);
  const preview = await openFile(state, workspace, path);
  if (
    !preview ||
    !state.connected ||
    state.client !== client ||
    state.connectionEpoch !== epoch ||
    !isCurrentSessionWorkspace(state, workspace) ||
    workspace.navigationOrder !== order ||
    workspace.activePreviewId !== preview.id ||
    !workspace.previews.includes(preview) ||
    preview.content.kind !== "file"
  ) {
    return;
  }
  const file = preview.content;
  const navigation = { view: { file, view } };
  preview.navigation = navigation;
  preview.navigationOrder = order;
  file.navigation = navigation;
  workspace.previews = [...workspace.previews];
  sessionWorkspaceForHost(state).publish();
}

export function revealSessionWorkspaceFile(state: SessionWorkspaceHost, path: string) {
  const workspace = getSessionWorkspace(state);
  clearWorkspaceTimer(workspace);
  const normalizedPath = path.replaceAll("\\", "/");
  const separator = normalizedPath.lastIndexOf("/");
  workspace.browserPath = separator > 0 ? normalizedPath.slice(0, separator) : "";
  workspace.browserSearch = "";
  workspace.filter = "all";
  workspace.activeId = `file:${path}`;
  loadSessionWorkspace(state, workspace, true);
  sessionWorkspaceForHost(state).publish();
}

function openArtifact(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  artifactId: string,
  disposition?: "pinned" | "preview",
  intent?: "navigate",
) {
  const query = {
    sessionKey: workspace.sessionKey,
    artifactId,
    ...(workspace.agentId ? { agentId: workspace.agentId } : {}),
  };
  const readDownload = async (signal: AbortSignal): Promise<Blob | null> => {
    const currentWorkspace = getSessionWorkspace(state);
    if (
      currentWorkspace.sessionKey !== query.sessionKey ||
      currentWorkspace.agentId !== workspace.agentId
    ) {
      return null;
    }
    // Cached preview actions bind a fresh connection on click; an in-flight
    // transfer must never follow a reconnect to a replacement Gateway.
    const client = state.client;
    const connectionEpoch = state.connectionEpoch;
    const result = await downloadArtifact(state, query, signal, { readBinary: true });
    if (
      signal.aborted ||
      !state.connected ||
      state.client !== client ||
      state.connectionEpoch !== connectionEpoch ||
      !isCurrentSessionWorkspace(state, currentWorkspace)
    ) {
      return null;
    }
    if (result?.blob) {
      return result.blob;
    }
    if (result?.encoding !== "base64" || result.data === undefined) {
      return null;
    }
    return new Blob([base64ToBytes(result.data)], {
      type: result.artifact.mimeType ?? "application/octet-stream",
    });
  };
  void openWorkspaceItem(
    state,
    workspace,
    `artifact:${artifactId}`,
    async () => {
      const result = await downloadArtifact(state, query);
      return result?.artifact
        ? {
            artifact: result.artifact,
            content: await loadArtifactSidebarContent(result, readDownload, state.resourceBasePath),
          }
        : null;
    },
    (result) => result.content,
    `Failed to load artifact ${artifactId}`,
    {
      disposition,
      intent,
      label:
        workspace.list?.artifacts?.find((artifact) => artifact.id === artifactId)?.title ||
        t("chat.workspaceFiles.artifacts"),
      resolveLabel: (result) => result.artifact?.title,
    },
  );
}

export function createSessionWorkspaceProps(
  state: SessionWorkspaceHost,
  options?: {
    presentation?: "desktop" | "mobile";
    openIntent?: "navigate";
    transcriptAttachments?: TranscriptAttachments;
    draftScope?: string;
    draftContext?: SessionWorkspaceHost["sessionWorkspaceDraftContext"];
    expanded?: boolean;
    presented?: boolean;
  },
) {
  state.sessionWorkspaceDraftScope = options?.draftScope;
  state.sessionWorkspaceDraftContext = options?.draftContext;
  const workspace = getSessionWorkspace(state);
  if (
    (options?.expanded === false || options?.presented === false) &&
    workspace.browserSearchTimer
  ) {
    clearWorkspaceTimer(workspace);
    workspace.pendingReload = true;
  }
  if (
    options?.presented !== false &&
    options?.expanded === true &&
    state.connected &&
    state.agentsList &&
    !workspace.loading &&
    !workspace.browserSearchTimer &&
    (!workspace.error || workspace.pendingReload) &&
    (workspace.pendingReload || workspace.list?.sessionKey !== state.sessionKey)
  ) {
    loadSessionWorkspace(state, workspace);
  }
  const diffContent = resolveSessionDiffSidebarContent(state);
  const navigation = captureSessionWorkspaceNavigation(workspace);
  const mobile =
    options?.presentation === "mobile"
      ? (workspace.mobileNavigation ??= {
          expandedGroups: { changed: true, read: false, artifacts: false, workspace: true },
          scrollTop: 0,
          locations: Object.create(null),
        })
      : undefined;
  const publish = () => sessionWorkspaceForHost(state).publish();
  const closeSearch = () => {
    clearWorkspaceTimer(workspace);
    workspace.browserSearch = "";
    workspace.tree!.searchOpen = false;
    loadSessionWorkspace(state, workspace);
    publish();
  };
  return {
    presentation: options?.presentation,
    folderView:
      options?.presentation === "desktop" &&
      workspace.previews.some(
        (preview) => preview.id === workspace.activePreviewId && preview.catalogVisible === true,
      ),
    transcriptAttachments: options?.transcriptAttachments,
    connected: state.connected,
    navigation,
    mobileNavigation: mobile
      ? { expandedGroups: { ...mobile.expandedGroups }, scrollTop: mobile.scrollTop }
      : undefined,
    onToggleMobileGroup: (kind: keyof SessionWorkspaceMobileNavigation["expandedGroups"]) => {
      if (!mobile) {
        return;
      }
      mobile.expandedGroups[kind] = !mobile.expandedGroups[kind];
      publish();
    },
    onMobileScroll: (top: number) => {
      if (mobile) {
        mobile.scrollTop = top;
      }
    },
    directories: workspace.directories,
    onToggleDirectory: (path: string) => {
      const tree = workspace.tree!;
      const expanded = tree.expandedPaths.includes(path);
      tree.expandedPaths = expanded
        ? tree.expandedPaths.filter((entry) => entry !== path)
        : [...tree.expandedPaths, path];
      if (!expanded) {
        void loadSessionWorkspaceDirectory(state, path);
      }
      publish();
    },
    onSearchOpenChange: (open: boolean) => {
      if (!open) {
        closeSearch();
        return;
      }
      workspace.tree!.searchOpen = true;
      workspace.tree!.treeVisible = true;
      publish();
    },
    onTreeVisibleChange: (visible: boolean) => {
      workspace.tree!.treeVisible = visible;
      if (!visible) {
        closeSearch();
      } else {
        publish();
      }
    },
    onSessionExpandedChange: (expanded: boolean) => {
      workspace.tree!.sessionExpanded = expanded;
      publish();
    },
    onNavigationScroll: (area: "tree" | "session", top: number) => {
      if (area === "tree") {
        workspace.tree!.treeScroll = top;
      } else {
        workspace.tree!.sessionScroll = top;
      }
    },
    sessionKey: state.sessionKey,
    readState: workspace,
    readResult: workspace.readResult,
    list: workspace.list?.sessionKey === state.sessionKey ? workspace.list : null,
    loading: workspace.loading,
    error: workspace.error ?? workspace.artifacts?.error ?? null,
    activeId: workspace.activeId,
    filter: workspace.filter,
    browserPath: workspace.browserPath,
    browserSearch: workspace.browserSearch,
    connectionEpoch: state.connectionEpoch,
    onDownloadFile: (path: string, origin: "session" | "workspace", signal: AbortSignal) =>
      downloadSessionFile(
        state,
        {
          sessionKey: workspace.sessionKey,
          agentId: workspace.agentId,
          path:
            origin === "workspace" ? workspaceBrowserFilePath(workspace.list?.root, path) : path,
        },
        signal,
      ),
    onSetFilter: (filter: SessionWorkspaceFilter) => {
      workspace.filter = filter;
      if (mobile && filter !== "all") {
        mobile.expandedGroups[filter] = true;
      }
      if (options?.presentation === "desktop" && (filter === "changed" || filter === "read")) {
        const paths = new Set(workspace.tree!.expandedPaths);
        for (const file of workspace.list?.files ?? []) {
          if (file.kind !== (filter === "changed" ? "modified" : "read")) {
            continue;
          }
          const path = file.workspacePath;
          if (!path || path.startsWith("/") || /^[a-z]:/i.test(path)) {
            continue;
          }
          const parts = path.split("/").slice(0, -1);
          parts.forEach((_, index) => paths.add(parts.slice(0, index + 1).join("/")));
        }
        workspace.tree!.expandedPaths = [...paths];
        workspace.tree!.sessionExpanded = true;
      }
      if (options?.presentation === "desktop" && filter === "all") {
        // Activity reveals ancestors without listing siblings. All fills only expanded paths.
        for (const path of workspace.tree!.expandedPaths) {
          void loadSessionWorkspaceDirectory(state, path);
        }
      }
      sessionWorkspaceForHost(state).publish();
    },
    onRetry: () => {
      clearWorkspaceTimer(workspace);
      loadSessionWorkspace(state, workspace, true);
    },
    onBrowsePath: (path: string) => {
      clearWorkspaceTimer(workspace);
      if (mobile) {
        mobile.locations[workspace.browserPath] = {
          search: workspace.browserSearch,
          filter: workspace.filter,
          scrollTop: mobile.scrollTop,
        };
      }
      const destination = mobile?.locations[path];
      workspace.browserPath = path;
      workspace.browserSearch = destination?.search ?? "";
      workspace.tree!.searchOpen = Boolean(workspace.browserSearch);
      workspace.filter = destination?.filter ?? "all";
      if (mobile) {
        mobile.scrollTop = destination?.scrollTop ?? 0;
      }
      workspace.tree!.treeScroll = 0;
      if (!mobile && !workspace.tree!.expandedPaths.includes(path)) {
        workspace.tree!.expandedPaths.push(path);
      }
      loadSessionWorkspace(state, workspace);
      publish();
    },
    onOpenFile: (
      path: string,
      origin: "session" | "workspace",
      disposition?: "pinned" | "preview",
    ) => {
      // Session paths are cwd-relative; browser rows are workspace-root-relative.
      // Keep the origin explicit so a nested cwd cannot shadow the selected browser file.
      const opts =
        origin === "workspace"
          ? { requestPath: workspaceBrowserFilePath(workspace.list?.root, path) }
          : {};
      void openFile(state, workspace, path, {
        ...opts,
        intent: options?.openIntent,
        disposition: options?.presentation === "desktop" ? (disposition ?? "preview") : undefined,
      });
    },
    onSearch: (search: string) => {
      if (mobile && search !== workspace.browserSearch) {
        mobile.scrollTop = 0;
        if (!workspace.browserPath && search.trim()) {
          mobile.expandedGroups = { changed: true, read: true, artifacts: true, workspace: true };
        }
      }
      workspace.browserSearch = search;
      workspace.tree!.searchOpen = true;
      sessionWorkspaceForHost(state).publish();
      clearWorkspaceTimer(workspace);
      workspace.browserSearchTimer = globalThis.setTimeout(() => {
        workspace.browserSearchTimer = null;
        loadSessionWorkspace(state, workspace);
      }, 160);
    },
    onOpenArtifact: (artifactId: string, disposition?: "pinned" | "preview") =>
      openArtifact(
        state,
        workspace,
        artifactId,
        options?.presentation === "desktop" ? (disposition ?? "preview") : undefined,
        options?.openIntent,
      ),
    onOpenDiff: diffContent ? () => state.handleOpenSidebar(diffContent) : undefined,
  };
}

export function resolveSessionDiffSidebarContent(
  state: SessionWorkspaceHost,
): SidebarContent | null {
  return resolveSessionWorkspaceDiff(state, (path) =>
    openFile(state, getSessionWorkspace(state), path),
  );
}
