import type { ApplicationContext } from "../../app/context.ts";
import { prepareSessionNavigationHandoff } from "../../lib/sessions/navigation-handoff.ts";
import {
  resolveSessionPreferredFaceForKey,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { sessionPathAgentId } from "./agent-scope.ts";

export function navigateToSessionFromPage(
  application: ApplicationContext,
  sessionKey: string,
): void {
  const face = resolveSessionPreferredFaceForKey(application, sessionKey);
  const target = sessionNavigationTarget({
    context: application,
    face,
    sessionKey,
    agentId: sessionPathAgentId(sessionKey, application),
    navigationKey: sessionKey,
    preferenceDerivedFace: true,
  });
  prepareSessionNavigationHandoff(application.gateway, target.options.pathname, sessionKey);
  application.navigate(face, target.options);
}
