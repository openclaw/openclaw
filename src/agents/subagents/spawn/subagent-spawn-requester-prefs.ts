import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { FastMode } from "../../../shared/fast-mode.js";
import { resolveFastModeState } from "../../fast-mode.js";
import {
  normalizeStoredOverrideModel,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "../../model-selection.js";
import { resolveThinkingDefault } from "../../model-thinking-default.js";
import {
  loadSessionEntry,
  resolveAgentConfig,
  resolveGatewaySessionStoreTarget,
} from "./subagent-spawn.runtime.js";

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
  });
  const selectedModel = resolvePersistedSelectedModelRef({
    defaultProvider: defaultModel.provider,
    runtimeProvider: entry.modelProvider,
    runtimeModel: entry.model,
    overrideProvider: normalizedOverride.providerOverride,
    overrideModel: normalizedOverride.modelOverride,
  });
  return { defaultModel, selectedModel };
}

export function readRequesterThinkingLevel(
  params: RequesterPreferencesContext,
): string | undefined {
  const entry = readRequesterSession(params);
  if (typeof entry?.thinkingLevel === "string" && entry.thinkingLevel.trim()) {
    return entry.thinkingLevel.trim();
  }
  const requesterAgentThinking = params.requesterAgentId
    ? resolveAgentConfig(params.cfg, params.requesterAgentId)?.thinkingDefault
    : undefined;
  if (requesterAgentThinking) {
    return requesterAgentThinking;
  }
  const { defaultModel, selectedModel } = resolveRequesterModel(params, entry);
  const model = selectedModel ?? defaultModel;
  return resolveThinkingDefault({
    cfg: params.cfg,
    provider: model.provider,
    model: model.model,
  });
}

export function readRequesterFastMode(params: RequesterPreferencesContext): FastMode {
  const entry = readRequesterSession(params);
  const { defaultModel, selectedModel } = resolveRequesterModel(params, entry);
  return resolveFastModeState({
    cfg: params.cfg,
    provider: selectedModel?.provider ?? defaultModel.provider,
    model: selectedModel?.model ?? defaultModel.model,
    agentId: params.requesterAgentId,
    sessionEntry: entry,
  }).mode;
}
