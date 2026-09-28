import type { ChatWorkContext } from "../../../../packages/gateway-protocol/src/chat-work-context.js";
import { isSessionRouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  resolveUiConversationIdentity,
  uiConversationMatches,
} from "../../lib/sessions/session-key.ts";
import { resolveSessionWorkspace } from "../../lib/sessions/workspace.ts";

export type { ChatWorkContext } from "../../../../packages/gateway-protocol/src/chat-work-context.js";

type PaneWorkContext = Pick<
  ChatWorkContext,
  "sessionKey" | "sessionId" | "agentId" | "file" | "workspace"
>;
type WorkContextStore = {
  panes: Map<object, PaneWorkContext>;
  listeners: Set<() => void>;
};
const stores = new WeakMap<object, WorkContextStore>();

function contextStore(context: object): WorkContextStore {
  let store = stores.get(context);
  if (!store) {
    store = { panes: new Map(), listeners: new Set() };
    stores.set(context, store);
  }
  return store;
}

/** Only visible work panes publish; the Home dock must never describe itself. */
export function publishChatWorkContext(
  context: object,
  pane: object,
  value?: PaneWorkContext,
): void {
  const store = contextStore(context);
  if (JSON.stringify(store.panes.get(pane)) === JSON.stringify(value)) {
    return;
  }
  if (value) {
    store.panes.set(pane, value);
  } else {
    store.panes.delete(pane);
  }
  for (const listener of store.listeners) {
    listener();
  }
}

export function subscribeChatWorkContext(context: object, listener: () => void): () => void {
  const { listeners } = contextStore(context);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function buildHomeWorkContext(
  context: Pick<ApplicationContext, "gateway" | "agents" | "sessions">,
  page: string,
  sessionKey: string,
  agentId: string,
): ChatWorkContext {
  if (!isSessionRouteId(page) || !sessionKey) {
    return { page };
  }
  const defaults = {
    hello: context.gateway.snapshot.hello,
    agentsList: context.agents.state.agentsList,
    assistantAgentId: agentId,
  };
  const identity = resolveUiConversationIdentity(defaults, sessionKey);
  const row = context.sessions.state.result?.sessions.find((candidate) =>
    // Keep the route's explicit agent: normalizing its main alias to bare global loses that owner.
    uiConversationMatches(defaults, sessionKey, candidate.key, candidate.agentId),
  );
  const agent = defaults.agentsList?.agents.find((candidate) => candidate.id === identity.agentId);
  const workspace = resolveSessionWorkspace({ session: row, agentWorkspace: agent?.workspace });
  const pane = [...contextStore(context).panes.values()].find(
    (candidate) =>
      candidate.sessionKey === identity.sessionKey && candidate.agentId === identity.agentId,
  );
  return {
    page,
    title: row?.label || row?.displayName || identity.sessionKey,
    ...identity,
    sessionId: row?.sessionId,
    workspace: workspace.root ?? undefined,
    ...pane,
  };
}
