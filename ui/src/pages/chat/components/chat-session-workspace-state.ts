import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import { normalizeChatWorkspaceDock } from "../../../app/settings.ts";
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
  SessionWorkspaceHost,
  SessionWorkspaceState,
} from "./chat-session-workspace-types.ts";
import type { SidebarSelection } from "./chat-sidebar.ts";

function resolvePaneAgent(state: SessionScopeHostWithKey): string {
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

export function clearWorkspaceTimer(workspace: SessionWorkspaceState | undefined) {
  if (workspace?.browserSearchTimer) {
    globalThis.clearTimeout(workspace.browserSearchTimer);
    workspace.browserSearchTimer = null;
  }
}

export function clearSessionWorkspaceTimers(state: SessionWorkspaceHost) {
  clearWorkspaceTimer(state.sessionWorkspaceState);
}

const checkoutSidebarContents = new WeakSet<object>();

export function trackSessionCheckoutSidebar(content: SidebarSelection) {
  checkoutSidebarContents.add(content);
}

export function openSessionCheckoutSidebar(state: SessionWorkspaceHost, content: SidebarSelection) {
  trackSessionCheckoutSidebar(content);
  state.handleOpenSidebar(content);
}

function clearSessionCheckoutSidebar(state: SessionWorkspaceHost) {
  if (state.sidebarContent && checkoutSidebarContents.has(state.sidebarContent)) {
    state.sidebarContent = null;
  }
}

function createSessionWorkspaceState(
  state: SessionWorkspaceHost,
  previous?: SessionWorkspaceState,
): SessionWorkspaceState {
  return {
    previews: [],
    activePreviewId: null,
    activeId: null,
    agentId: resolvePaneAgent(state),
    browserPath: "",
    browserSearch: "",
    filter: "all",
    browserSearchTimer: null,
    collapsed: previous?.collapsed ?? true,
    connectionEpoch: state.connectionEpoch,
    // Dock preference is app-wide, seeded from the host's loaded settings;
    // per-session state just carries it forward.
    dock: previous?.dock ?? normalizeChatWorkspaceDock(state.settings?.chatWorkspaceDock),
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
  const next = createSessionWorkspaceState(state, current);
  state.sessionWorkspaceState = next;
  return next;
}

export function requestWorkspaceUpdate(state: SessionWorkspaceHost) {
  state.requestUpdate?.();
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

export function loadSessionWorkspace(
  state: SessionWorkspaceHost,
  workspace: SessionWorkspaceState,
  force = false,
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (workspace.loading) {
    if (force) {
      workspace.pendingReload = true;
    }
    return;
  }
  workspace.loading = true;
  setSessionWorkspaceError(workspace, null);
  if (force) {
    workspace.list = null;
  }
  workspace.pendingReload = false;
  const sessionKey = state.sessionKey;
  const agentId = workspace.agentId;
  const client = state.client;
  const browserPath = workspace.browserPath;
  const browserSearch = workspace.browserSearch;
  // Session ownership survives folder/search changes; this response belongs to its query.
  const isCurrentListing = () =>
    isCurrentSessionWorkspace(state, workspace) &&
    workspace.browserPath === browserPath &&
    workspace.browserSearch === browserSearch;
  void (async () => {
    try {
      const [files, artifacts] = await Promise.all([
        state.sessions.listFiles(sessionKey, {
          path: browserSearch ? "" : browserPath,
          search: browserSearch,
          agentId,
        }),
        client.request<{
          artifacts?: SessionWorkspaceListResult["artifacts"];
        } | null>("artifacts.list", {
          sessionKey,
          ...(agentId ? { agentId } : {}),
        }),
      ]);
      if (!isCurrentListing()) {
        return;
      }
      const fileItems = files?.files ?? [];
      const artifactItems = artifacts?.artifacts ?? [];
      workspace.list = {
        sessionKey,
        ...(files?.root ? { root: files.root } : {}),
        ...(typeof files?.gitCheckout === "boolean" ? { gitCheckout: files.gitCheckout } : {}),
        files: fileItems,
        ...(files?.browser ? { browser: files.browser } : {}),
        artifacts: artifactItems,
      };
    } catch (error) {
      if (isCurrentListing()) {
        setSessionWorkspaceError(workspace, formatUiError(error));
      }
    } finally {
      if (isCurrentSessionWorkspace(state, workspace)) {
        workspace.loading = false;
      }
      requestWorkspaceUpdate(state);
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
  if (!refreshFiles) {
    workspace.pendingReload = true;
    return diffOpen;
  }
  if (workspace.loading) {
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
  const next = createSessionWorkspaceState(state, current);
  state.sessionWorkspaceState = next;
  requestWorkspaceUpdate(state);
}

/** File tabs are transient workspace presentation, scoped by this controller's lifecycle. */
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
  requestWorkspaceUpdate(state);
  return preview;
}

export function selectSessionWorkspacePreview(state: SessionWorkspaceHost, id: string | null) {
  const workspace = getSessionWorkspace(state);
  if (id === null || workspace.previews.some((entry) => entry.id === id)) {
    workspace.activePreviewId = id;
    requestWorkspaceUpdate(state);
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
  requestWorkspaceUpdate(state);
}

export function clearSessionWorkspacePreviews(state: SessionWorkspaceHost) {
  const workspace = state.sessionWorkspaceState;
  if (workspace) {
    workspace.previews = [];
    workspace.activePreviewId = null;
    requestWorkspaceUpdate(state);
  }
}
