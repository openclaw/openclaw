import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";

/** Opens the main chat of an agent a Template just created, from any add surface. */
export function openTemplateAgentChat(context: ApplicationContext, agentId: string) {
  const mainKey =
    resolveUiConfiguredMainKey({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    }) ?? "main";
  const sessionKey = buildAgentMainSessionKey({ agentId, mainKey });
  const target = sessionNavigationTarget({
    context,
    face: "chat",
    sessionKey,
    agentId,
  });
  selectApplicationSession({
    selection: context.agentSelection,
    gateway: context.gateway,
    sessionKey,
    agentId,
  });
  context.navigate("chat", target.options);
}
