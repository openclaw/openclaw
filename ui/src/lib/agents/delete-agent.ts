import type { ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import { formatUiError } from "../format-error.ts";
import { canCallGatewayMethod } from "../gateway-methods.ts";
import { registerEnglishCatalog, t } from "../reactive/i18n.ts";
import { showToast } from "../toast.ts";

registerEnglishCatalog(registerAgentsHomeEnglish);

type AgentDeletionContext = Pick<ApplicationContext, "agents" | "gateway">;

export function canDeleteAgent(context: AgentDeletionContext, id: string): boolean {
  const agents =
    context.agents.state.agentsList?.agents.filter((agent) => agent.kind !== "system") ?? [];
  return (
    agents.length > 1 &&
    agents.some((agent) => agent.id === id) &&
    canCallGatewayMethod(context.gateway.snapshot, "agents.delete", "operator.admin")
  );
}

// Every entry point shares confirmation, live admission, and roster reconciliation.
export async function deleteAgent(
  context: AgentDeletionContext,
  agent: { id: string; name: string },
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const client = context.gateway.snapshot.client;
  if (!client || !isCurrent() || !canDeleteAgent(context, agent.id)) {
    return;
  }
  const confirmed = await showConfirmDialog({
    title: t("agentsHome.deleteAgentConfirm", { agent: agent.name }),
    message: t("agentsHome.deleteAgentDetails"),
    confirmLabel: t("common.delete"),
    danger: true,
  }).catch((error: unknown) => {
    showToast({ severity: "error", message: formatUiError(error) });
    return false;
  });
  if (
    !confirmed ||
    context.gateway.snapshot.client !== client ||
    !isCurrent() ||
    !canDeleteAgent(context, agent.id)
  ) {
    return;
  }
  try {
    await client.request("agents.delete", { agentId: agent.id, deleteFiles: true });
  } catch (error) {
    showToast({ severity: "error", message: formatUiError(error) });
  } finally {
    await context.agents.refreshList();
  }
}
