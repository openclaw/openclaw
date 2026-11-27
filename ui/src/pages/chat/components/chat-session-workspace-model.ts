import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionScopeHostWithKey } from "../../../lib/sessions/index.ts";
import { scopedAgentParamsForSession } from "../../../lib/sessions/navigation.ts";
import {
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../../../lib/sessions/session-key.ts";
import type {
  SessionWorkspaceHost,
  SessionWorkspaceState,
} from "./chat-session-workspace-types.ts";

export function resolvePaneAgent(state: SessionScopeHostWithKey): string {
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

export function createSessionWorkspaceState(state: SessionWorkspaceHost): SessionWorkspaceState {
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
