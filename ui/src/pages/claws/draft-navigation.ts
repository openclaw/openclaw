import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { LAB_FEATURES, resolveLabFeatureState } from "../labs/labs-registry.ts";

const clawsLab = LAB_FEATURES.find((feature) => feature.id === "claws");
registerEnglishCatalog(registerAgentsHomeEnglish);

export type ClawDraftTarget = {
  agentId: string;
  draftId?: string;
  sourceSessionKey?: string;
};

export function canCreateClawDraft(context: ApplicationContext): boolean {
  return Boolean(
    clawsLab &&
    canCallGatewayMethod(context.gateway.snapshot, "claws.drafts.create", "operator.admin") &&
    resolveLabFeatureState(currentConfigObject(context.runtimeConfig.state), clawsLab).enabled,
  );
}

function clawDraftSearch(target: ClawDraftTarget): string {
  const query = new URLSearchParams(
    target.draftId ? { draft: target.draftId, agent: target.agentId } : { create: target.agentId },
  );
  if (target.sourceSessionKey) {
    query.set("session", target.sourceSessionKey);
  }
  return `?${query}`;
}

export function clawDraftUrl(basePath: string, target: ClawDraftTarget): string {
  return `${pathForRoute("claws", basePath)}${clawDraftSearch(target)}`;
}

export function navigateToClawDraft(context: ApplicationContext, target: ClawDraftTarget): void {
  context.navigate("claws", {
    pathname: pathForRoute("claws", context.basePath),
    search: clawDraftSearch(target),
  });
}

export function clawDraftTargetFromSearch(search: string): ClawDraftTarget | null {
  const query = new URLSearchParams(search);
  const draftId = query.get("draft");
  const agentId = draftId ? query.get("agent") : query.get("create");
  if (!agentId) {
    return null;
  }
  return {
    agentId,
    ...(draftId ? { draftId } : {}),
    ...(query.get("session") ? { sourceSessionKey: query.get("session")! } : {}),
  };
}
