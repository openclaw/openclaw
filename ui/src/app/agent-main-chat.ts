import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";
import { selectApplicationSession } from "./agent-selection.ts";
import type { ApplicationContext } from "./context.ts";

/** Opens an agent's main chat, such as one a Template just created or a channel continues. */
export function openAgentMainChat(context: ApplicationContext, agentId: string) {
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

/** Opens the default agent's main chat, where channel DMs continue under the default DM scope. */
export function openDefaultAgentMainChat(context: ApplicationContext) {
  openAgentMainChat(
    context,
    resolveUiDefaultAgentId({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    }),
  );
}
