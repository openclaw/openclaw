import type { ApplicationContext } from "../../app/context.ts";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { resolveLabFeatureState } from "../labs/labs-feature-state.ts";
import { TEMPLATES_LAB_FEATURE } from "../labs/templates-lab-feature.ts";

registerEnglishCatalog(registerAgentsHomeEnglish);

export type TemplateDraftTarget = {
  agentId: string;
  draftId?: string;
};

export function canCreateTemplateDraft(context: ApplicationContext): boolean {
  return (
    canCallGatewayMethod(context.gateway.snapshot, "templates.drafts.create", "operator.admin") &&
    canCallGatewayMethod(context.gateway.snapshot, "chat.send", "operator.write") &&
    resolveLabFeatureState(currentConfigObject(context.runtimeConfig.state), TEMPLATES_LAB_FEATURE)
      .enabled
  );
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
