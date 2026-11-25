import type { ApplicationContext } from "../../app/context.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { isTemplatesAvailable } from "./availability.ts";

export type TemplateDraftTarget = {
  agentId: string;
  draftId?: string;
};

export function canCreateTemplateDraft(context: ApplicationContext): boolean {
  return templateDraftUnavailableReason(context) === null;
}

export function templateDraftUnavailableReason(context: ApplicationContext) {
  const state = context.runtimeConfig.state;
  const available = isTemplatesAvailable(state);
  if (available === null) {
    return state.lastError ? "unavailable" : "loading";
  }
  if (!available) {
    return "disabled";
  }
  return canCallGatewayMethod(
    context.gateway.snapshot,
    "templates.drafts.create",
    "operator.admin",
  ) && canCallGatewayMethod(context.gateway.snapshot, "chat.send", "operator.write")
    ? null
    : "unavailable";
}

export function templateDraftTargetFromSearch(search: string): TemplateDraftTarget | null {
  const query = new URLSearchParams(search);
  const draftId = query.get("draft");
  const agentId = draftId ? query.get("agent") : query.get("create");
  if (!agentId) {
    return null;
  }
  return {
    agentId,
    ...(draftId ? { draftId } : {}),
  };
}
