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
import { resolveGatewaySessionStoreTargetInWorker } from "./subagent-spawn.runtime.js";

type RequesterPreferencesContext = {
  cfg: OpenClawConfig;
  requesterInternalKey: string;
  requesterAgentId?: string;
  assertActive?: () => void;
};

async function readRequesterSession(
  params: RequesterPreferencesContext,
): Promise<SessionEntry | undefined> {
  try {
    const target = await resolveGatewaySessionStoreTargetInWorker({
      cfg: params.cfg,
      key: params.requesterInternalKey,
      agentId: params.requesterAgentId,
      assertActive: params.assertActive,
    });
    return target.store[target.canonicalKey];
  } catch {
    return undefined;
  } finally {
    params.assertActive?.();
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

export async function readRequesterPreferences(params: RequesterPreferencesContext) {
  const entry = await readRequesterSession(params);
  params.assertActive?.();
  const { defaultModel, selectedModel } = resolveRequesterModel(params, entry);
  const model = selectedModel ?? defaultModel;
  return {
    model: selectedModel ?? undefined,
    thinkingLevel:
      (typeof entry?.thinkingLevel === "string" && entry.thinkingLevel.trim()) ||
      resolveThinkingDefault({
        cfg: params.cfg,
        agentId: params.requesterAgentId,
        provider: model.provider,
        model: model.model,
      }),
  };
}

export async function readRequesterFastMode(
  params: RequesterPreferencesContext & { requesterModel?: ModelRef; childModel: string },
): Promise<FastMode | undefined> {
  const entry = await readRequesterSession(params);
  params.assertActive?.();
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
