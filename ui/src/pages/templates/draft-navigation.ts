import type { ApplicationContext } from "../../app/context.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { resolveLabFeatureState } from "../labs/labs-feature-state.ts";
import { TEMPLATES_LAB_FEATURE } from "../labs/templates-lab-feature.ts";

export type TemplateDraftTarget = {
  agentId: string;
  draftId?: string;
};

export function canCreateTemplateDraft(context: ApplicationContext): boolean {
  return templateDraftUnavailableReason(context) === null;
}

export function templateDraftUnavailableReason(context: ApplicationContext) {
  if (
    !resolveLabFeatureState(currentConfigObject(context.runtimeConfig.state), TEMPLATES_LAB_FEATURE)
      .enabled
  ) {
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
