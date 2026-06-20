import { scopedAgentParamsForSession } from "../../ui/app-chat.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { resolveAgentIdFromSessionKey, normalizeAgentId } from "../../ui/session-key.ts";
import type { SidebarContent } from "../../ui/sidebar-content.ts";
import { normalizeOptionalString } from "../../ui/string-coerce.ts";
import type {
  ArtifactDownloadResult,
  SessionWorkspaceGetResult,
  SessionWorkspaceListResult,
} from "../../ui/types.ts";
import type { ChatProps } from "../../ui/views/chat.ts";

type SessionWorkspaceProps = NonNullable<ChatProps["sessionWorkspace"]>;

type WorkspaceState = {
  activeId: string | null;
  agentId: string;
  browserPath: string;
  browserSearch: string;
  browserSearchTimer: ReturnType<typeof globalThis.setTimeout> | null;
  collapsed: boolean;
  error: string | null;
  list: SessionWorkspaceListResult | null;
  loading: boolean;
  pendingReload: boolean;
  requestId: number;
  sessionKey: string;
};

const workspaceStates = new WeakMap<AppViewState, WorkspaceState>();
const openRequests = new WeakMap<
  AppViewState,
  { agentId: string; id: number; itemId: string; sessionKey: string }
>();
type OpenRequest = {
  agentId: string;
  id: number;
  itemId: string;
  sessionKey: string;
};

function workspaceAgentId(state: AppViewState): string {
  const normalizedKey = normalizeOptionalString(state.sessionKey)?.toLowerCase();
  const activeAgentId =
    normalizedKey === "global" ? null : resolveAgentIdFromSessionKey(state.sessionKey);
  const scopedAgentId = scopedAgentParamsForSession(state, state.sessionKey).agentId;
  const fallback = normalizeAgentId(
    state.assistantAgentId ??
      state.agentsList?.defaultId ??
      state.agentsList?.agents?.[0]?.id ??
      "main",
  );
  return normalizedKey === "global"
    ? (scopedAgentId ?? fallback)
    : (activeAgentId ?? scopedAgentId ?? fallback);
}

function getWorkspaceState(state: AppViewState): WorkspaceState {
  const sessionKey = state.sessionKey;
  const agentId = workspaceAgentId(state);
  const current = workspaceStates.get(state);
  if (current?.sessionKey === sessionKey && current.agentId === agentId) {
    return current;
  }
  const next: WorkspaceState = {
    activeId: null,
    agentId,
    browserPath: "",
    browserSearch: "",
    browserSearchTimer: null,
    collapsed: true,
    error: null,
    list: null,
    loading: false,
    pendingReload: false,
    requestId: 0,
    sessionKey,
  };
  workspaceStates.set(state, next);
  return next;
}

function currentWorkspaceState(state: AppViewState): WorkspaceState {
  return getWorkspaceState(state);
}

function requestUpdate(state: AppViewState) {
  state.requestUpdate?.();
}

function languageForFile(name: string): string {
  const extension = name.match(/\.([a-z0-9_-]+)$/i)?.[1]?.toLowerCase() ?? "";
  if (extension === "yml") {
    return "yaml";
  }
  return extension;
}

function fileSidebarContent(name: string, content: string): string {
  if (/\.(?:md|markdown|mdx)$/i.test(name)) {
    return content;
  }
  return `# ${name}\n\n\`\`\`${languageForFile(name)}\n${content}\n\`\`\``;
}

function artifactSidebarContent(params: {
  data?: string;
  encoding?: string;
  mimeType: string;
  title: string;
  url?: string;
}): SidebarContent {
  const { data, encoding, mimeType, title, url } = params;
  if (encoding === "base64" && data && mimeType.startsWith("image/")) {
    return {
      kind: "image",
      title,
      src: `data:${mimeType};base64,${data}`,
      mimeType,
      rawText: url ?? null,
    };
  }
  if (encoding === "base64" && data && mimeType === "application/json") {
    const decoded = globalThis.atob(data);
    return {
      kind: "markdown",
      content: `# ${title}\n\n\`\`\`json\n${decoded}\n\`\`\``,
      rawText: decoded,
    };
  }
  if (encoding === "base64" && data && mimeType.startsWith("text/")) {
    const decoded = globalThis.atob(data);
    return {
      kind: "markdown",
      content: `# ${title}\n\n\`\`\`\n${decoded}\n\`\`\``,
      rawText: decoded,
    };
  }
  if (url) {
    const content = `# ${title}\n\n[Open artifact](${url})`;
    return { kind: "markdown", content, rawText: content };
  }
  const content = `# ${title}\n\nArtifact download is not previewable in the sidebar.`;
  return { kind: "markdown", content, rawText: content };
}

function loadWorkspace(state: AppViewState, workspace: WorkspaceState, force = false) {
  if (!state.client || !state.connected) {
    return;
  }
  if (workspace.loading) {
    if (force) {
      workspace.pendingReload = true;
    }
    return;
  }
  const requestId = workspace.requestId + 1;
  workspace.requestId = requestId;
  workspace.loading = true;
  workspace.error = null;
  if (force) {
    workspace.list = null;
  }
  workspace.pendingReload = false;
  const sessionKey = state.sessionKey;
  const agentId = workspace.agentId;
  void (async () => {
    try {
      const files = await state.client?.request<SessionWorkspaceListResult | null>(
        "sessions.files.list",
        {
          sessionKey,
          path: workspace.browserSearch ? "" : workspace.browserPath,
          search: workspace.browserSearch,
          ...(agentId ? { agentId } : {}),
        },
      );
      const artifacts = await state.client?.request<{
        artifacts?: SessionWorkspaceListResult["artifacts"];
      } | null>("artifacts.list", {
        sessionKey,
        ...(agentId ? { agentId } : {}),
      });
      const current = currentWorkspaceState(state);
      if (current !== workspace || current.requestId !== requestId) {
        return;
      }
      const fileItems = files?.files ?? [];
      const artifactItems = artifacts?.artifacts ?? [];
      current.list = {
        sessionKey,
        ...(files?.root ? { root: files.root } : {}),
        files: fileItems,
        ...(files?.browser ? { browser: files.browser } : {}),
        artifacts: artifactItems,
      };
      if (
        current.activeId &&
        !fileItems.some((file) => `file:${file.path}` === current.activeId) &&
        !artifactItems.some((artifact) => `artifact:${artifact.id}` === current.activeId)
      ) {
        current.activeId = null;
      }
    } catch (error) {
      const current = currentWorkspaceState(state);
      if (current === workspace && current.requestId === requestId) {
        current.error = String(error);
      }
    } finally {
      const current = currentWorkspaceState(state);
      if (current === workspace && current.requestId === requestId) {
        current.loading = false;
        const reload = current.pendingReload;
        current.pendingReload = false;
        if (reload) {
          loadWorkspace(state, current, true);
        }
      }
      requestUpdate(state);
    }
  })();
}

function beginOpenRequest(
  state: AppViewState,
  workspace: WorkspaceState,
  itemId: string,
): OpenRequest {
  workspace.activeId = itemId;
  const previous = openRequests.get(state);
  const request: OpenRequest = {
    agentId: workspace.agentId,
    id: (previous?.id ?? 0) + 1,
    itemId,
    sessionKey: state.sessionKey,
  };
  openRequests.set(state, request);
  return request;
}

function isCurrentOpenRequest(
  state: AppViewState,
  workspace: WorkspaceState,
  request: OpenRequest,
): boolean {
  const currentRequest = openRequests.get(state);
  const current = currentWorkspaceState(state);
  return (
    currentRequest?.id === request.id &&
    currentRequest.agentId === workspaceAgentId(state) &&
    currentRequest.itemId === request.itemId &&
    currentRequest.sessionKey === state.sessionKey &&
    current?.agentId === request.agentId &&
    current.activeId === request.itemId
  );
}

function openWorkspaceItem<T>(
  state: AppViewState,
  workspace: WorkspaceState,
  itemId: string,
  load: (request: OpenRequest) => Promise<T | null | undefined>,
  render: (result: T) => SidebarContent | null,
  missingMessage: string,
) {
  const request = beginOpenRequest(state, workspace, itemId);
  void (async () => {
    if (!state.client || !state.connected) {
      return;
    }
    workspace.error = null;
    try {
      const result = await load(request);
      const content = result == null ? null : render(result);
      if (!content) {
        if (isCurrentOpenRequest(state, workspace, request)) {
          workspace.error = missingMessage;
          requestUpdate(state);
        }
        return;
      }
      if (isCurrentOpenRequest(state, workspace, request)) {
        state.handleOpenSidebar(content);
      }
    } catch (error) {
      if (isCurrentOpenRequest(state, workspace, request)) {
        workspace.error = String(error);
      }
    } finally {
      requestUpdate(state);
    }
  })();
}

function openFile(state: AppViewState, workspace: WorkspaceState, path: string) {
  openWorkspaceItem(
    state,
    workspace,
    `file:${path}`,
    (request) =>
      state.client!.request<SessionWorkspaceGetResult | null>("sessions.files.get", {
        sessionKey: request.sessionKey,
        path,
        ...(request.agentId ? { agentId: request.agentId } : {}),
      }),
    (result) => {
      const file = result.file;
      return !file || typeof file.content !== "string"
        ? null
        : {
            kind: "markdown",
            content: fileSidebarContent(file.name || path, file.content),
            rawText: file.content,
          };
    },
    `Failed to load ${path}`,
  );
}

function openArtifact(state: AppViewState, workspace: WorkspaceState, artifactId: string) {
  openWorkspaceItem(
    state,
    workspace,
    `artifact:${artifactId}`,
    (request) =>
      state.client!.request<ArtifactDownloadResult | null>("artifacts.download", {
        sessionKey: request.sessionKey,
        artifactId,
        ...(request.agentId ? { agentId: request.agentId } : {}),
      }),
    (result) =>
      !result.artifact
        ? null
        : artifactSidebarContent({
            data: result.data,
            encoding: result.encoding,
            mimeType: result.artifact.mimeType ?? "",
            title: result.artifact.title,
            url: result.url,
          }),
    `Failed to load artifact ${artifactId}`,
  );
}

export function createSessionWorkspaceProps(state: AppViewState): SessionWorkspaceProps {
  const workspace = getWorkspaceState(state);
  if (
    !workspace.collapsed &&
    state.connected &&
    state.agentsList &&
    !workspace.loading &&
    !workspace.error &&
    workspace.list?.sessionKey !== state.sessionKey
  ) {
    loadWorkspace(state, workspace);
  }
  return {
    collapsed: workspace.collapsed,
    sessionKey: state.sessionKey,
    list: workspace.list?.sessionKey === state.sessionKey ? workspace.list : null,
    loading: workspace.loading,
    error: workspace.error,
    activeId: workspace.activeId,
    onToggleCollapsed: () => {
      workspace.collapsed = !workspace.collapsed;
      if (!workspace.collapsed && workspace.list?.sessionKey !== state.sessionKey) {
        loadWorkspace(state, workspace);
      }
      requestUpdate(state);
    },
    onRefresh: () => loadWorkspace(state, workspace, true),
    onBrowsePath: (path) => {
      if (workspace.browserSearchTimer) {
        globalThis.clearTimeout(workspace.browserSearchTimer);
        workspace.browserSearchTimer = null;
      }
      workspace.browserPath = path;
      workspace.browserSearch = "";
      loadWorkspace(state, workspace, true);
    },
    onCopyPath: (path) => {
      void globalThis.navigator?.clipboard?.writeText?.(path);
    },
    onOpenFile: (path) => openFile(state, workspace, path),
    onSearch: (search) => {
      workspace.browserSearch = search;
      if (workspace.browserSearchTimer) {
        globalThis.clearTimeout(workspace.browserSearchTimer);
      }
      workspace.browserSearchTimer = globalThis.setTimeout(() => {
        workspace.browserSearchTimer = null;
        loadWorkspace(state, workspace, true);
      }, 160);
    },
    onOpenArtifact: (artifactId) => openArtifact(state, workspace, artifactId),
  };
}
