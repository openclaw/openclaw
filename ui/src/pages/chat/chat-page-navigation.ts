import type { ApplicationContext } from "../../app/context.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import {
  resolveSessionNavigationAgentId,
  resolveSessionPreferredFaceForKey,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { isUiGlobalSessionKey, uiConversationMatches } from "../../lib/sessions/session-key.ts";
import { currentRouteLocation } from "./chat-canonical-location.ts";
import { locationWithoutDraft } from "./route-draft.ts";
import type { SessionChatRouteData } from "./session-route-data.ts";

export function navigateChatPage(
  context: ApplicationContext,
  data: SessionChatRouteData | undefined,
  sessionKey: string,
  replace = false,
  explicitFace?: BoardFace,
): void {
  const agentId = resolveSessionNavigationAgentId(context, data?.agentId);
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
    face = resolveSessionPreferredFaceForKey(context, sessionKey, data?.agentId);
  }
  const options = sessionNavigationTarget({
    context,
    face,
    preferenceDerivedFace: explicitFace === undefined && !sameSession,
    sessionKey,
    agentId: data?.agentId,
    shortIdLength: data?.sessionKey === sessionKey ? data.shortId?.length : undefined,
  }).options;
  const location =
    replace && sameSession && (data.draft || data.focusComposer)
      ? locationWithoutDraft(currentRouteLocation(), options)
      : options;
  context[replace ? "replace" : "navigate"](face, location);
}
