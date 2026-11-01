import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CyberAccessProgram } from "../../../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { FastMode } from "../../../shared/fast-mode.js";
import { resolveFastModeState } from "../../fast-mode.js";
import {
  type ModelRef,
  normalizeStoredOverrideModel,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "../../model-selection.js";
import {
  resolveConfiguredThinkingDefault,
  resolveThinkingDefault,
} from "../../model-thinking-default.js";

type RequesterPreferencesContext = {
  cfg: OpenClawConfig;
  requesterAgentId?: string;
  requesterEntry: SessionEntry | undefined;
};

function resolveRequesterModel(params: RequesterPreferencesContext) {
  const entry = params.requesterEntry;
  const defaultModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.requesterAgentId,
  });
  if (!entry) {
    return { defaultModel, selectedModel: undefined };
  }
  const normalizedOverride = normalizeStoredOverrideModel({
    providerOverride: entry.providerOverride,
    modelOverride: entry.modelOverride,
    routeResolution: entry.modelOverrideRouteResolution,
  });
  const selectedModel = resolvePersistedSelectedModelRef({
    defaultProvider: defaultModel.provider,
    runtimeProvider: entry.modelProvider,
    runtimeModel: entry.model,
    overrideProvider: normalizedOverride.providerOverride,
    overrideModel: normalizedOverride.modelOverride,
    overrideRouteResolution: entry.modelOverrideRouteResolution,
  });
  return { defaultModel, selectedModel };
}

export function resolveRequesterPreferences(params: RequesterPreferencesContext) {
  const entry = params.requesterEntry;
  const { defaultModel, selectedModel } = resolveRequesterModel(params);
  const model = selectedModel ?? defaultModel;
  const thinkingParams = {
    cfg: params.cfg,
    agentId: params.requesterAgentId,
    provider: model.provider,
    model: model.model,
  };
  const selectedThinkingLevel =
    normalizeOptionalString(entry?.thinkingLevel) ??
    resolveConfiguredThinkingDefault(thinkingParams);
  return {
    model: selectedModel ?? undefined,
    thinkingLevel: selectedThinkingLevel ?? resolveThinkingDefault(thinkingParams),
    thinkingExplicit: selectedThinkingLevel !== undefined,
  };
}

/**
 * Explicit child Access wins. Otherwise a same-agent child on the requester's
 * model keeps the requester's saved session Access; a different agent or model
 * starts at its own default because programs are advertised per account and model.
 * The child's runtime still checks the program before every model request.
 */
export function resolveSubagentCyberAccessProgram(
  params: RequesterPreferencesContext & {
    requested?: CyberAccessProgram;
    targetAgentId: string;
    requesterModel?: ModelRef;
    childModel: string;
  },
): CyberAccessProgram | undefined {
  if (params.requested !== undefined) {
    return params.requested;
  }
  const inherited = params.requesterEntry?.cyberAccessProgram;
  if (inherited === undefined || params.targetAgentId !== params.requesterAgentId) {
    return undefined;
  }
  let model = params.requesterModel;
  if (!model) {
    const { defaultModel, selectedModel } = resolveRequesterModel(params);
    model = selectedModel ?? defaultModel;
  }
  return params.childModel === `${model.provider}/${model.model}` ? inherited : undefined;
}

export function resolveRequesterFastMode(
  params: RequesterPreferencesContext & { requesterModel?: ModelRef; childModel: string },
): FastMode | undefined {
  const entry = params.requesterEntry;
  let model = params.requesterModel;
  if (!model) {
    const { defaultModel, selectedModel } = resolveRequesterModel(params);
    model = selectedModel ?? defaultModel;
  }
  if (params.childModel !== `${model.provider}/${model.model}`) {
    return undefined;
  }
  return resolveFastModeState({
    cfg: params.cfg,
    provider: model.provider,
    model: model.model,
    agentId: params.requesterAgentId,
    sessionEntry: entry,
  }).requestMode;
}
