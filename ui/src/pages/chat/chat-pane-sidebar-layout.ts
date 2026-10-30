import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { uiConversationMatches } from "../../lib/sessions/session-key.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import type { SidebarFullMessageLoader } from "./components/chat-sidebar-content-types.ts";
import type { SidebarRegionParams } from "./components/chat-sidebar-region-types.ts";
import { closeSlot, fitSidebarLayout, openSlot, type SidebarLayout } from "./sidebar-layout.ts";

const DETAIL_FULL_MESSAGE_MAX_CHARS = 500_000;
export function renderSidebarRegion(params: SidebarRegionParams) {
  const panelIdPrefix = `chat-panel-${encodeURIComponent(params.presentationId)}`;
  return {
    ...params,
    panelIdPrefix,
    panelDefinitions: params.panelDefinitions ?? sidebarPanelDefinitions(),
  };
}

export function resolveSidebarLayoutForBoard(params: {
  board: ResolvedBoardView;
  layout: SidebarLayout;
  paneWidth: number;
}): SidebarLayout {
  let layout = params.layout;
  if (!params.board.available) {
    layout = closeSlot(layout, "dashboard");
  } else if (params.board.face === "dashboard" && layout.columns.length === 0) {
    layout = openSlot(layout, "dashboard");
  }
  return fitSidebarLayout(layout, params.paneWidth) ?? layout;
}

type FullMessageScope = ReturnType<typeof readSidebarFullMessageScope>;

function readSidebarFullMessageScope(state: ChatPageHost, gateway: ApplicationGateway) {
  const auth = gateway.snapshot.hello?.auth;
  const session = selectedChatSessionRow(state);
  return {
    owner: gatewayPresentationScope(gateway),
    sessionKey: state.sessionKey,
    agentId: resolveChatAgentId(state),
    sessionId: session?.sessionId,
    displayedSessionId: state.currentSessionId ?? undefined,
    lifecycleRevision: session?.lifecycleRevision,
    authorizationKey: JSON.stringify([
      state.mediaPolicyEpoch ?? 0,
      auth?.role,
      (auth?.scopes ?? []).toSorted(),
    ]),
  };
}

type FullMessageCache = FullMessageScope & {
  messages: Map<string, Awaited<ReturnType<SidebarFullMessageLoader>>>;
};
const fullMessageCaches = new WeakMap<object, FullMessageCache>();

export function createSidebarFullMessageLoader(
  state: ChatPageHost,
  gateway: ApplicationGateway,
): SidebarFullMessageLoader | null {
  if (parseCatalogSessionKey(state.sessionKey) || !state.client || !state.connected) {
    return null;
  }
  const readScope = () => readSidebarFullMessageScope(state, gateway);
  return async (request) => {
    if (!state.client || !state.connected) {
      return null;
    }
    const client = state.client;
    const generation = state.connectionEpoch;
    const scope = readScope();
    const sameScope = (other: FullMessageScope) =>
      scope.owner === other.owner &&
      scope.sessionKey === other.sessionKey &&
      scope.agentId === other.agentId &&
      scope.sessionId === other.sessionId &&
      scope.displayedSessionId === other.displayedSessionId &&
      scope.lifecycleRevision === other.lifecycleRevision &&
      scope.authorizationKey === other.authorizationKey;
    let cache = fullMessageCaches.get(state);
    if (!cache || !sameScope(cache)) {
      cache = { ...scope, messages: new Map() };
      fullMessageCaches.set(state, cache);
    }
    const maxChars = request.maxChars ?? DETAIL_FULL_MESSAGE_MAX_CHARS;
    const pendingInput = request.messageId.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX);
    const sameConversation = uiConversationMatches(
      state,
      scope.sessionKey,
      request.sessionKey,
      request.agentId,
      scope.agentId,
    );
    const sessionId =
      request.sessionId ??
      (sameConversation && !pendingInput && scope.displayedSessionId !== scope.sessionId
        ? scope.displayedSessionId
        : undefined);
    const cacheable =
      !pendingInput &&
      sameConversation &&
      scope.sessionId !== undefined &&
      scope.sessionId === scope.displayedSessionId &&
      (sessionId === undefined || sessionId === scope.sessionId) &&
      scope.lifecycleRevision !== undefined;
    const key = JSON.stringify([scope.sessionKey, scope.agentId, request.messageId, maxChars]);
    const cached = cacheable ? cache.messages.get(key) : undefined;
    if (cached) {
      return cached;
    }
    const result = await client.request<Awaited<ReturnType<SidebarFullMessageLoader>>>(
      "chat.message.get",
      {
        sessionKey: request.sessionKey,
        ...(request.agentId ? { agentId: request.agentId } : {}),
        ...(sessionId ? { sessionId } : {}),
        messageId: request.messageId,
        maxChars,
      },
    );
    if (
      !state.connected ||
      state.client !== client ||
      state.connectionEpoch !== generation ||
      !sameScope(readScope())
    ) {
      return null;
    }
    const message = asOptionalRecord(result?.message);
    if (
      cacheable &&
      result?.ok &&
      message &&
      !asOptionalRecord(message["__openclaw"])?.importedFrom &&
      !(message.role === "assistant" && message.stopReason === "error")
    ) {
      // Imported content and retry-hidden errors can change without a session lifecycle change.
      if (cache.messages.size >= 16) {
        cache.messages.delete(cache.messages.keys().next().value!);
      }
      cache.messages.set(key, result);
    }
    return result;
  };
}
