import { resolveSessionModelOverrideRouteResolution } from "../../../config/sessions/model-override-provenance.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { FastMode } from "../../../shared/fast-mode.js";
import { resolveFastModeState } from "../../fast-mode.js";
import {
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "../../model-selection.js";
import { resolveThinkingDefault } from "../../model-thinking-default.js";
import {
  loadSessionEntry,
  resolveAgentConfig,
  resolveGatewaySessionStoreTarget,
} from "./subagent-spawn.runtime.js";

export function readRequesterThinkingLevel(params: {
  cfg: OpenClawConfig;
  requesterInternalKey: string;
  requesterAgentId?: string;
}): string | undefined {
  let entry: SessionEntry | undefined;
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.requesterInternalKey,
      agentId: params.requesterAgentId,
    });
    entry = loadSessionEntry({
      storePath: target.storePath,
      sessionKey: target.canonicalKey,
      clone: false,
    });
  } catch {
    entry = undefined;
  }
  if (typeof entry?.thinkingLevel === "string" && entry.thinkingLevel.trim()) {
    return entry.thinkingLevel.trim();
  }
  const requesterAgentThinking = params.requesterAgentId
    ? resolveAgentConfig(params.cfg, params.requesterAgentId)?.thinkingDefault
    : undefined;
  if (requesterAgentThinking) {
    return requesterAgentThinking;
  }
  const defaultModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.requesterAgentId,
  });
  if (entry) {
    const persistedModel = resolvePersistedSelectedModelRef({
      cfg: params.cfg,
      routeResolution: resolveSessionModelOverrideRouteResolution(entry),
      defaultProvider: defaultModel.provider,
      runtimeProvider: entry.modelProvider,
      runtimeModel: entry.model,
      overrideProvider: entry.providerOverride,
      overrideModel: entry.modelOverride,
    });
    if (persistedModel) {
      return resolveThinkingDefault({
        cfg: params.cfg,
        provider: persistedModel.provider,
        model: persistedModel.model,
      });
    }
  }
  return resolveThinkingDefault({
    cfg: params.cfg,
    provider: defaultModel.provider,
    model: defaultModel.model,
  });
}

export function readRequesterFastMode(params: {
  cfg: OpenClawConfig;
  requesterInternalKey: string;
  requesterAgentId?: string;
}): FastMode {
  let entry: SessionEntry | undefined;
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.requesterInternalKey,
      agentId: params.requesterAgentId,
    });
    entry = loadSessionEntry({
      storePath: target.storePath,
      sessionKey: target.canonicalKey,
      clone: false,
    });
  } catch {
    entry = undefined;
  }
  const defaultModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.requesterAgentId,
  });
  const selectedModel = entry
    ? resolvePersistedSelectedModelRef({
        cfg: params.cfg,
        routeResolution: resolveSessionModelOverrideRouteResolution(entry),
        defaultProvider: defaultModel.provider,
        runtimeProvider: entry.modelProvider,
        runtimeModel: entry.model,
        overrideProvider: entry.providerOverride,
        overrideModel: entry.modelOverride,
      })
    : undefined;
  return resolveFastModeState({
    cfg: params.cfg,
    provider: selectedModel?.provider ?? defaultModel.provider,
    model: selectedModel?.model ?? defaultModel.model,
    agentId: params.requesterAgentId,
    sessionEntry: entry,
  }).mode;
}
