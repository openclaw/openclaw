import type { ApplicationContext } from "../../app/context.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import {
  resolveSessionNavigationAgentId,
  resolveSessionPreferredFaceForKey,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  isUiGlobalSessionKey,
  isUiGlobalScopeConfigured,
  resolveUiConfiguredMainKey,
  uiConversationMatches,
} from "../../lib/sessions/session-key.ts";
import { currentRouteLocation } from "./chat-canonical-location.ts";
import type { SessionChatRouteData } from "./session-route-data.ts";

const paneRouteData = new WeakMap<
  SessionChatRouteData,
  { sessionKey: string; value: SessionChatRouteData }
>();

export function sameChatPaneRoute(
  context: ApplicationContext,
  before: SessionChatRouteData | undefined,
  after: SessionChatRouteData | undefined,
): boolean {
  return Boolean(
    before &&
    after &&
    uiConversationMatches(
      { agentsList: context.agents.state.agentsList, hello: context.gateway.snapshot.hello },
      before.sessionKey,
      after.sessionKey,
      after.agentId,
      before.agentId,
    ),
  );
}

export function ownedChatPaneRouteData(
  context: ApplicationContext,
  data: SessionChatRouteData,
): SessionChatRouteData {
  if (!isUiGlobalSessionKey(data?.sessionKey) || !data.agentId?.trim()) {
    return data;
  }
  const sessionKey = ownedChatPaneSessionKey(context, data.sessionKey, data.agentId);
  if (sessionKey === data.sessionKey) {
    return data;
  }
  let cached = paneRouteData.get(data);
  // Route identity owns one-shot draft/focus consumption; keep the projection stable.
  if (cached?.sessionKey !== sessionKey) {
    cached = { sessionKey, value: { ...data, sessionKey } };
    paneRouteData.set(data, cached);
  }
  return cached.value;
}

export function ownedChatPaneSessionKey(
  context: ApplicationContext,
  sessionKey: string,
  agentId?: string,
): string {
  return isUiGlobalSessionKey(sessionKey) &&
    agentId?.trim() &&
    isUiGlobalScopeConfigured({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    })
    ? buildAgentMainSessionKey({
        agentId,
        mainKey: resolveUiConfiguredMainKey({
          agentsList: context.agents.state.agentsList,
          hello: context.gateway.snapshot.hello,
        }),
      })
    : sessionKey;
}

export function navigateChatPage(
  context: ApplicationContext,
  data: SessionChatRouteData | undefined,
  sessionKey: string,
  replace = false,
  explicitFace?: BoardFace,
  targetAgentId?: string,
): void {
  const agentId = resolveSessionNavigationAgentId(context, targetAgentId ?? data?.agentId);
  // Adopting a canonical global spelling is not a new conversation. Re-resolving
  // its face before the roster arrives makes cached alias/global routes alternate.
  const sameSession =
    data &&
    uiConversationMatches(
      {
        agentsList: context.agents.state.agentsList,
        hello: context.gateway.snapshot.hello,
        assistantAgentId: agentId,
      },
      data.sessionKey,
      sessionKey,
      isUiGlobalSessionKey(sessionKey) ? agentId : undefined,
      data.agentId,
    );
  let face = explicitFace ?? data?.face ?? "chat";
  if (explicitFace === undefined && !sameSession) {
    face = resolveSessionPreferredFaceForKey(context, sessionKey, targetAgentId ?? data?.agentId);
  }
  const options = sessionNavigationTarget({
    context,
    face,
    preferenceDerivedFace: explicitFace === undefined && !sameSession,
    sessionKey,
    agentId: targetAgentId ?? data?.agentId,
    shortIdLength: data?.sessionKey === sessionKey ? data.shortId?.length : undefined,
  }).options;
  let location = options;
  if (replace && sameSession && (data.draft || data.focusComposer)) {
    const current = currentRouteLocation();
    const params = new URLSearchParams(current.search);
    for (const [name, value] of new URLSearchParams(options.search)) {
      params.set(name, value);
    }
    // Canonical key replacement is not acknowledgement of a route draft.
    // Only the page that observed its recipient commit may retire the hint.
    const search = params.toString();
    location = { ...current, ...options, search: search ? `?${search}` : "" };
  }
  context[replace ? "replace" : "navigate"](face, location);
}
