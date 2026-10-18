import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createChangeListeners } from "../../../../../src/shared/listeners.js";
import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import {
  scopedAgentParamsForSession,
  type SessionScopeHostWithKey,
} from "../../../lib/sessions/index.ts";
import {
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../../../lib/sessions/session-key.ts";
import type {
  SessionWorkspaceArtifacts,
  SessionWorkspaceHost,
  SessionWorkspaceState,
} from "./chat-session-workspace-types.ts";
import type { SessionWorkspaceNavigation, SidebarSelection } from "./chat-sidebar-content-types.ts";

type SessionWorkspaceOwner = {
  readonly state: SessionWorkspaceState | undefined;
  subscribe(listener: () => void): () => void;
  publish(): void;
};

const workspaceOwners = new WeakMap<SessionWorkspaceHost, SessionWorkspaceOwner>();

/** Publishes workspace mutations without replacing the raw preview and editor identities. */
export function sessionWorkspaceForHost(host: SessionWorkspaceHost): SessionWorkspaceOwner {
  let owner = workspaceOwners.get(host);
  if (!owner) {
    const listeners = createChangeListeners();
    owner = {
      get state() {
        return host.sessionWorkspaceState;
      },
      subscribe: listeners.subscribe,
      publish: listeners.publish,
    };
    workspaceOwners.set(host, owner);
  }
  return owner;
}

function resolvePaneAgent(state: SessionScopeHostWithKey): string {
  if (normalizeOptionalString(state.sessionKey)?.toLowerCase() !== "global") {
    return resolveAgentIdFromSessionKey(state.sessionKey);
  }
  return (
    scopedAgentParamsForSession(state, state.sessionKey).agentId ??
    normalizeAgentId(
      state.assistantAgentId ??
        state.agentsList?.defaultId ??
        state.agentsList?.agents?.[0]?.id ??
        "main",
    )
  );
}

export function clearWorkspaceTimer(workspace: SessionWorkspaceState | undefined) {
  if (workspace?.browserSearchTimer) {
    globalThis.clearTimeout(workspace.browserSearchTimer);
    workspace.browserSearchTimer = null;
  }
}

const checkoutSidebarContents = new WeakSet<object>();

export function trackSessionCheckoutSidebar(content: SidebarSelection) {
  checkoutSidebarContents.add(content);
}

function clearSessionCheckoutSidebar(state: SessionWorkspaceHost) {
  if (state.sidebarContent && checkoutSidebarContents.has(state.sidebarContent)) {
    state.sidebarContent = null;
  }
}

function createSessionWorkspaceState(state: SessionWorkspaceHost): SessionWorkspaceState {
  return {
    tree: {
      expandedPaths: [""],
      searchOpen: false,
      sessionExpanded: true,
      treeVisible: true,
      treeScroll: 0,
      sessionScroll: 0,
    },
    directories: Object.create(null),
    artifacts: { items: [], resolved: false, loaded: false, loading: false, error: null },
    previews: [],
    activePreviewId: null,
    activeId: null,
    agentId: resolvePaneAgent(state),
    browserPath: "",
    browserSearch: "",
    filter: "all",
    browserSearchTimer: null,
    connectionEpoch: state.connectionEpoch,
    error: null,
    list: null,
    loading: false,
    pendingReload: false,
    sessionKey: state.sessionKey,
  };
}

export function isCurrentSessionWorkspace(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
) {
  return (
    state.sessionWorkspaceState === workspace &&
    workspace.sessionKey === state.sessionKey &&
    workspace.agentId === resolvePaneAgent(state) &&
    workspace.connectionEpoch === state.connectionEpoch
  );
}

export function getSessionWorkspace(state: SessionWorkspaceHost): SessionWorkspaceState {
  const current = state.sessionWorkspaceState;
  if (current && isCurrentSessionWorkspace(state, current)) {
    return current;
  }
  clearSessionCheckoutSidebar(state);
  clearWorkspaceTimer(current);
  const next = createSessionWorkspaceState(state);
  state.sessionWorkspaceState = next;
  return next;
}

export function setSessionWorkspaceError(
  workspace: SessionWorkspaceState,
  message: string | null,
  owner?: object,
) {
  workspace.error = message;
  workspace.errorOwner = owner;
}

export function clearSessionWorkspaceError(workspace: SessionWorkspaceState, owner: object) {
  if (workspace.errorOwner === owner) {
    setSessionWorkspaceError(workspace, null);
  }
}

type ArtifactRole = "all" | "assistant";
const artifactLoads = new WeakMap<SessionWorkspaceArtifacts, Promise<void>>();
const artifactDemands = new WeakMap<SessionWorkspaceHost, Map<ArtifactRole, number>>();
const directoryLoads = new WeakMap<SessionWorkspaceState, Map<string, Promise<void>>>();
type FileListing = Awaited<ReturnType<SessionWorkspaceHost["sessions"]["listFiles"]>>;
const fileLoads = new WeakMap<SessionWorkspaceState, Map<string, Promise<FileListing>>>();
const artifactRefreshPending = new WeakSet<SessionWorkspaceArtifacts>();

function requestWorkspaceFiles(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  path: string,
  search = "",
) {
  let requests = fileLoads.get(workspace);
  if (!requests) {
    requests = new Map();
    fileLoads.set(workspace, requests);
  }
  const key = JSON.stringify([path, search]);
  const pending = requests.get(key);
  if (pending) {
    return pending;
  }
  const request = state.sessions.listFiles(workspace.sessionKey, {
    path,
    search,
    agentId: workspace.agentId,
  });
  requests.set(key, request);
  void request.finally(() => requests.delete(key)).catch(() => {});
  return request;
}

/** One owner, separate native query variants: summaries do not expose message role. */
export function loadSessionWorkspaceArtifacts(
  state: SessionWorkspaceHost,
  force = false,
  messageRole?: "assistant",
): Promise<void> {
  const workspace = getSessionWorkspace(state);
  const key = messageRole === "assistant" ? "assistantArtifacts" : "artifacts";
  const artifacts = (workspace[key] ??= {
    items: [],
    resolved: false,
    loaded: false,
    loading: false,
    error: null,
  });
  const pending = artifactLoads.get(artifacts);
  if (pending) {
    if (force) {
      artifactRefreshPending.add(artifacts);
    }
    return pending;
  }
  if (!state.client || !state.connected || (artifacts.loaded && !force)) {
    return Promise.resolve();
  }
  artifacts.loading = true;
  artifacts.error = null;
  const client = state.client;
  const request = (async () => {
    try {
      const result = await client.request<{
        artifacts?: SessionWorkspaceListResult["artifacts"];
      } | null>("artifacts.list", {
        sessionKey: workspace.sessionKey,
        agentId: workspace.agentId,
        ...(messageRole ? { messageRole } : {}),
      });
      // A run refresh invalidates this response even if Files has no retained demand.
      if (!isCurrentSessionWorkspace(state, workspace) || artifactRefreshPending.has(artifacts)) {
        return;
      }
      artifacts.items = result?.artifacts ?? [];
      artifacts.loaded = true;
      artifacts.resolved = true;
      if (!messageRole && workspace.list) {
        workspace.list = { ...workspace.list, artifacts: artifacts.items };
      }
    } catch (error) {
      if (isCurrentSessionWorkspace(state, workspace) && !artifactRefreshPending.has(artifacts)) {
        artifacts.error = formatUiError(error);
      }
    } finally {
      artifacts.loading = false;
      artifactLoads.delete(artifacts);
      if (isCurrentSessionWorkspace(state, workspace)) {
        if (artifactRefreshPending.delete(artifacts)) {
          void loadSessionWorkspaceArtifacts(state, true, messageRole);
        } else {
          sessionWorkspaceForHost(state).publish();
        }
      }
    }
  })();
  artifactLoads.set(artifacts, request);
  sessionWorkspaceForHost(state).publish();
  return request;
}

/** Outputs retains assistant; Files/default retains the complete catalog. */
export function retainSessionWorkspaceArtifacts(
  state: SessionWorkspaceHost,
  messageRole?: "assistant",
): () => void {
  let demands = artifactDemands.get(state);
  if (!demands) {
    demands = new Map();
    artifactDemands.set(state, demands);
  }
  const role = messageRole ?? "all";
  demands.set(role, (demands.get(role) ?? 0) + 1);
  void loadSessionWorkspaceArtifacts(state, false, messageRole);
  return () => demands.set(role, Math.max(0, (demands.get(role) ?? 1) - 1));
}

/** Only an explicitly visited directory is fetched, never its descendants. */
export function loadSessionWorkspaceDirectory(
  state: SessionWorkspaceHost,
  path: string,
  force = false,
): Promise<void> {
  const workspace = getSessionWorkspace(state);
  const directories = (workspace.directories ??= Object.create(null));
  let requests = directoryLoads.get(workspace);
  if (!requests) {
    requests = new Map();
    directoryLoads.set(workspace, requests);
  }
  const pending = requests.get(path);
  if (pending) {
    return pending;
  }
  if (!state.connected || !state.client || (directories[path]?.browser && !force)) {
    return Promise.resolve();
  }
  const directory = (directories[path] ??= { loading: false, error: null });
  directory.loading = true;
  directory.error = null;
  const request = (async () => {
    try {
      const result = await requestWorkspaceFiles(state, workspace, path);
      if (!isCurrentSessionWorkspace(state, workspace) || workspace.directories !== directories) {
        return;
      }
      directory.browser = result?.browser;
      if (!result?.browser) {
        directory.error = "";
      }
    } catch (error) {
      if (isCurrentSessionWorkspace(state, workspace)) {
        directory.error = formatUiError(error);
      }
    } finally {
      directory.loading = false;
      requests.delete(path);
      if (isCurrentSessionWorkspace(state, workspace)) {
        sessionWorkspaceForHost(state).publish();
      }
    }
  })();
  requests.set(path, request);
  sessionWorkspaceForHost(state).publish();
  return request;
}

export function captureSessionWorkspaceNavigation(
  workspace: SessionWorkspaceState,
): SessionWorkspaceNavigation {
  const tree = (workspace.tree ??= {
    expandedPaths: [""],
    searchOpen: false,
    sessionExpanded: true,
    treeVisible: true,
    treeScroll: 0,
    sessionScroll: 0,
  });
  return {
    ...tree,
    expandedPaths: [...tree.expandedPaths],
    browserPath: workspace.browserPath,
    browserSearch: workspace.browserSearch,
    filter: workspace.filter,
  };
}

/** The tabs owner calls this without changing preview identity or reader contents. */
export function restoreSessionWorkspaceNavigation(
  state: SessionWorkspaceHost,
  navigation: SessionWorkspaceNavigation,
) {
  const workspace = getSessionWorkspace(state);
  clearWorkspaceTimer(workspace);
  const { browserPath, browserSearch, filter, ...tree } = navigation;
  workspace.browserPath = browserPath;
  workspace.browserSearch = browserSearch;
  workspace.filter = filter;
  workspace.tree = { ...tree, expandedPaths: [...tree.expandedPaths] };
  loadSessionWorkspace(state, workspace);
  for (const path of tree.expandedPaths) {
    void loadSessionWorkspaceDirectory(state, path);
  }
  sessionWorkspaceForHost(state).publish();
}

export function loadSessionWorkspace(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  force = false,
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (workspace.loading) {
    workspace.pendingReload = true;
    return;
  }
  workspace.loading = true;
  setSessionWorkspaceError(workspace, null);
  workspace.pendingReload = false;
  const { sessionKey, browserPath, browserSearch } = workspace;
  if (force) {
    workspace.list = null;
    workspace.directories = Object.create(null);
    directoryLoads.delete(workspace);
    fileLoads.delete(workspace);
  }
  const directories = (workspace.directories ??= Object.create(null));
  const isCurrentListing = () =>
    isCurrentSessionWorkspace(state, workspace) &&
    workspace.directories === directories &&
    workspace.browserPath === browserPath &&
    workspace.browserSearch === browserSearch;
  sessionWorkspaceForHost(state).publish();
  void (async () => {
    try {
      const [files] = await Promise.all([
        requestWorkspaceFiles(state, workspace, browserSearch ? "" : browserPath, browserSearch),
        loadSessionWorkspaceArtifacts(state, force),
      ]);
      if (!isCurrentListing()) {
        return;
      }
      workspace.list = {
        ...files,
        sessionKey,
        files: files?.files ?? [],
        artifacts: workspace.artifacts?.items ?? [],
      };
      if (files?.browser && !browserSearch) {
        (workspace.directories ??= Object.create(null))[browserPath] = {
          browser: files.browser,
          loading: false,
          error: null,
        };
        for (const path of workspace.tree?.expandedPaths ?? []) {
          if (path !== browserPath) {
            void loadSessionWorkspaceDirectory(state, path);
          }
        }
      }
    } catch (error) {
      if (isCurrentListing()) {
        setSessionWorkspaceError(workspace, formatUiError(error));
      }
    } finally {
      if (isCurrentSessionWorkspace(state, workspace)) {
        workspace.loading = false;
        if (!isCurrentListing()) {
          workspace.list = null;
        }
        sessionWorkspaceForHost(state).publish();
      }
    }
  })();
}

/** Refresh workspace facts after a run, which may have created a git checkout. */
export function refreshSessionWorkspaceState(
  state: SessionWorkspaceHost,
  refreshFiles: boolean,
): boolean {
  const workspace = state.sessionWorkspaceState;
  if (!workspace || workspace.sessionKey !== state.sessionKey) {
    return false;
  }
  const diffOpen =
    workspace.diffContent !== undefined && state.sidebarContent === workspace.diffContent;
  delete workspace.diffContent;
  for (const role of ["all", "assistant"] as const) {
    const artifacts = role === "all" ? workspace.artifacts : workspace.assistantArtifacts;
    if (artifacts) {
      // Keep prior facts during refresh; the invalidated request cannot replace them.
      artifacts.loaded = false;
      if (artifactLoads.has(artifacts)) {
        artifactRefreshPending.add(artifacts);
      }
    }
    if ((artifactDemands.get(state)?.get(role) ?? 0) > 0) {
      void loadSessionWorkspaceArtifacts(state, true, role === "assistant" ? role : undefined);
    }
  }
  workspace.directories = Object.create(null);
  directoryLoads.delete(workspace);
  fileLoads.delete(workspace);
  if (!refreshFiles || workspace.loading) {
    workspace.pendingReload = true;
  } else {
    loadSessionWorkspace(state, workspace);
  }
  return diffOpen;
}

/** Retire facts owned by one checkout without disturbing panel layout or retained drafts. */
export function retireSessionWorkspaceCheckout(state: SessionWorkspaceHost) {
  const current = state.sessionWorkspaceState;
  if (!current || current.sessionKey !== state.sessionKey) {
    return;
  }
  clearSessionCheckoutSidebar(state);
  clearWorkspaceTimer(current);
  state.sessionWorkspaceState = createSessionWorkspaceState(state);
  for (const [role, count] of artifactDemands.get(state) ?? []) {
    if (count > 0) {
      void loadSessionWorkspaceArtifacts(state, false, role === "assistant" ? role : undefined);
    }
  }
  sessionWorkspaceForHost(state).publish();
}

/** File tabs are transient presentation scoped to this workspace. */
export function openSessionWorkspacePreview(
  state: SessionWorkspaceHost,
  id: string,
  label: string,
  content: SidebarSelection,
) {
  const workspace = getSessionWorkspace(state);
  let preview = workspace.previews.find(
    (entry) => entry.id === id || entry.requestIds?.includes(id),
  );
  if (!preview) {
    preview = { id, label, content };
    workspace.previews = [...workspace.previews, preview];
  }
  workspace.activePreviewId = preview.id;
  sessionWorkspaceForHost(state).publish();
  return preview;
}

export function selectSessionWorkspacePreview(state: SessionWorkspaceHost, id: string | null) {
  const workspace = getSessionWorkspace(state);
  if (id === null || workspace.previews.some((entry) => entry.id === id)) {
    workspace.activePreviewId = id;
    sessionWorkspaceForHost(state).publish();
  }
}

export function closeSessionWorkspacePreview(state: SessionWorkspaceHost, id: string) {
  const workspace = getSessionWorkspace(state);
  const index = workspace.previews.findIndex((entry) => entry.id === id);
  if (index < 0) {
    return;
  }
  workspace.previews = workspace.previews.filter((entry) => entry.id !== id);
  if (workspace.activePreviewId === id) {
    workspace.activePreviewId =
      workspace.previews[Math.min(index, workspace.previews.length - 1)]?.id ?? null;
  }
  sessionWorkspaceForHost(state).publish();
}

export function clearSessionWorkspacePreviews(state: SessionWorkspaceHost) {
  const workspace = state.sessionWorkspaceState;
  if (workspace) {
    workspace.previews = [];
    workspace.activePreviewId = null;
    sessionWorkspaceForHost(state).publish();
  }
}
