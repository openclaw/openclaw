import type { SetupFirstAgent } from "../../../../packages/gateway-protocol/src/schema/setup-inference.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";

/** Setup returns the regular agent's exact Home, never a separate setup conversation. */
export function openFirstAgentConversation(context: ApplicationContext, agent: SetupFirstAgent) {
  selectApplicationSession({
    selection: context.agentSelection,
    gateway: context.gateway,
    agentId: agent.agentId,
    sessionKey: agent.sessionKey,
  });
  const target = sessionNavigationTarget({
    context,
    face: "chat",
    agentId: agent.agentId,
    sessionKey: agent.sessionKey,
    focusComposer: true,
  });
  const search = new URLSearchParams(target.options.search ?? "");
  if (agent.bootstrapPending) {
    search.set("draft", t("modelSetup.hatchDraft"));
  }
  context.navigate("chat", {
    ...target.options,
    search: `?${search.toString()}`,
  });
}
