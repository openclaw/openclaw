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
import { resolveThinkingDefault } from "../../model-thinking-default.js";
import { loadSessionEntry, resolveGatewaySessionStoreTarget } from "./subagent-spawn.runtime.js";

type RequesterPreferencesContext = {
  cfg: OpenClawConfig;
  requesterInternalKey: string;
  requesterAgentId?: string;
};

function readRequesterSession(params: RequesterPreferencesContext): SessionEntry | undefined {
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.requesterInternalKey,
      agentId: params.requesterAgentId,
    });
    return loadSessionEntry({
      storePath: target.storePath,
      sessionKey: target.canonicalKey,
      clone: false,
    });
  } catch {
    return undefined;
  }
}

function resolveRequesterModel(params: RequesterPreferencesContext, entry?: SessionEntry) {
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

export function readRequesterModel(params: RequesterPreferencesContext) {
  const entry = readRequesterSession(params);
  return entry ? (resolveRequesterModel(params, entry).selectedModel ?? undefined) : undefined;
}

export function readRequesterThinkingLevel(
  params: RequesterPreferencesContext,
): string | undefined {
  const entry = readRequesterSession(params);
  if (typeof entry?.thinkingLevel === "string" && entry.thinkingLevel.trim()) {
    return entry.thinkingLevel.trim();
  }
  const { defaultModel, selectedModel } = resolveRequesterModel(params, entry);
  const model = selectedModel ?? defaultModel;
  return resolveThinkingDefault({
    cfg: params.cfg,
    agentId: params.requesterAgentId,
    provider: model.provider,
    model: model.model,
  });
}

export function readRequesterFastMode(
  params: RequesterPreferencesContext & { requesterModel?: ModelRef; childModel: string },
): FastMode | undefined {
  const entry = readRequesterSession(params);
  let model = params.requesterModel;
  if (!model) {
    const { defaultModel, selectedModel } = resolveRequesterModel(params, entry);
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
  }).mode;
}
