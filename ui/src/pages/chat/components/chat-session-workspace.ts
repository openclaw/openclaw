import { GatewayRequestError } from "../../../api/gateway-connect-errors.ts";
import type { MarkdownFileLinkTarget } from "../../../components/markdown-file-links.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { pathDisplayName } from "../../../lib/path-display.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import { parseAgentSessionKey } from "../../../lib/sessions/session-key.ts";
import { sessionWorkspaceFileKey } from "../../../lib/sessions/workspace.ts";
import { resolveSessionWorkspaceDiff } from "./chat-session-workspace-diff.ts";
import { workspaceBrowserFilePath } from "./chat-session-workspace-file-content.ts";
import { openWorkspaceItem } from "./chat-session-workspace-preview.ts";
import {
  captureSessionWorkspaceNavigation,
  loadSessionWorkspaceDirectory,
  clearWorkspaceTimer,
  getSessionWorkspace,
  isCurrentSessionWorkspace,
  loadSessionWorkspace,
  refreshSessionWorkspaceState,
  selectSessionWorkspacePreview,
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

export function refreshSessionWorkspace(state: SessionWorkspaceHost, refreshFiles: boolean) {
  if (refreshSessionWorkspaceState(state, refreshFiles)) {
    state.sidebarContent = resolveSessionDiffSidebarContent(state);
    sessionWorkspaceForHost(state).publish();
  }
}

async function readWorkspaceContent<T>(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  read: (runtime: typeof import("./chat-session-workspace-content.runtime.ts")) => Promise<T>,
): Promise<T | null> {
  const client = state.client;
  const {
    downloadSessionFile,
    loadSessionWorkspaceArtifactContent,
    loadSessionWorkspaceFileContent,
  } = await import("./chat-session-workspace-content.runtime.ts");
  // Loading code cannot transfer an admitted preview to a replacement connection or checkout.
  return state.connected && state.client === client && isCurrentSessionWorkspace(state, workspace)
    ? read({
        downloadSessionFile,
        loadSessionWorkspaceArtifactContent,
        loadSessionWorkspaceFileContent,
      })
    : null;
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
  const draftScope = state.sessionWorkspaceDraftScope;
  const draftContext = state.sessionWorkspaceDraftContext;
  const gatewayUrl = state.settings?.gatewayUrl ?? "";
  return openWorkspaceItem(
    state,
    workspace,
    viewingSession && !opts.messageEntryId
      ? `file:${requestPath}`
      : JSON.stringify(["file", sessionKey, requestPath, opts.messageEntryId]),
    () =>
      readWorkspaceContent(state, workspace, (runtime) =>
        runtime.loadSessionWorkspaceFileContent(
          state,
          workspace,
          {
            requestPath,
            sessionKey,
            agentId,
            messageEntryId: opts.messageEntryId,
            line: opts.line,
            draftScope,
            draftContext,
            gatewayUrl,
          },
          () => refreshSessionWorkspace(state, true),
        ),
      ),
    (result) => result.content,
    `Failed to load ${path}`,
    {
      line: opts.line,
      disposition: opts.disposition,
      intent: opts.intent,
      label: pathDisplayName(path),
      revalidate: true,
      resolveLabel: ({ result }) => result.file?.name,
      resolveKey: ({ result }) => {
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
  workspace.tree!.treeVisible = true;
  workspace.tree!.searchOpen = false;
  // Selecting Files must restore the explicit reveal, not the previous catalog filter.
  workspace.catalogNavigation = captureSessionWorkspaceNavigation(workspace);
  selectSessionWorkspacePreview(state, null);
  workspace.activeId = `file:${path}`;
  loadSessionWorkspace(state, workspace, true);
  sessionWorkspaceForHost(state).publish();
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
      readWorkspaceContent(state, workspace, (runtime) =>
        runtime.downloadSessionFile(
          state,
          {
            sessionKey: workspace.sessionKey,
            agentId: workspace.agentId,
            path:
              origin === "workspace" ? workspaceBrowserFilePath(workspace.list?.root, path) : path,
          },
          signal,
        ),
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
    onOpenArtifact: (artifactId: string, disposition?: "pinned" | "preview") => {
      const artifactDisposition =
        options?.presentation === "desktop" ? (disposition ?? "preview") : undefined;
      const openIntent = options?.openIntent;
      void openWorkspaceItem(
        state,
        workspace,
        `artifact:${artifactId}`,
        (signal) =>
          readWorkspaceContent(state, workspace, (runtime) =>
            runtime.loadSessionWorkspaceArtifactContent(state, workspace, artifactId, signal),
          ),
        (result) => result.content,
        `Failed to load artifact ${artifactId}`,
        {
          disposition: artifactDisposition,
          intent: openIntent,
          label:
            workspace.list?.artifacts?.find((artifact) => artifact.id === artifactId)?.title ||
            t("chat.workspaceFiles.artifacts"),
          resolveLabel: (result) => result.artifact?.title,
        },
      );
    },
    onOpenDiff: diffContent ? () => state.handleOpenSidebar(diffContent) : undefined,
  };
}

export function resolveSessionDiffSidebarContent(
  state: SessionWorkspaceHost,
): SidebarContent | null {
  const workspace = getSessionWorkspace(state);
  return resolveSessionWorkspaceDiff(
    state,
    (path) => openFile(state, getSessionWorkspace(state), path),
    async (path) => {
      const client = state.client;
      if (!client || !state.connected || !isCurrentSessionWorkspace(state, workspace)) {
        return false;
      }
      try {
        // Inspect the actual reader capability without selecting a tab or touching its draft.
        const loaded = await readWorkspaceContent(state, workspace, (runtime) =>
          runtime.loadSessionWorkspaceFileContent(
            state,
            workspace,
            {
              requestPath: path,
              sessionKey: workspace.sessionKey,
              agentId: workspace.agentId,
              gatewayUrl: state.settings?.gatewayUrl ?? "",
            },
            () => refreshSessionWorkspace(state, true),
          ),
        );
        return (
          state.connected &&
          state.client === client &&
          isCurrentSessionWorkspace(state, workspace) &&
          loaded?.content?.kind === "file" &&
          Boolean(loaded.content.edit)
        );
      } catch {
        // Reading actions remain available; the ordinary open owns errors and revalidation.
        return false;
      }
    },
  );
}
