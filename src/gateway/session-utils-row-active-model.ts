import { resolveSelectedAndActiveModel } from "../auto-reply/model-runtime.js";
import type { InternalSessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveProjectedAgentRunModel,
  type ProjectedAgentRunIndex,
} from "../infra/agent-run-registry.js";
import { resolveActiveFallbackState } from "../status/fallback-notice-state.js";
import { readSessionFallbackModel } from "../status/session-fallback-model.js";

export function resolveGatewaySessionActiveModel(params: {
  cfg: OpenClawConfig;
  active?: boolean;
  activeModel?: { provider: string; model: string } | null;
  terminalModel?: { modelProvider: string; model: string } | null;
  agentId: string;
  storeAgentId?: string;
  sessionId?: string;
  sessionKey: string;
  projectedAgentRuns: ProjectedAgentRunIndex;
  selectedModel: { provider: string; model: string };
  entry?: InternalSessionEntry;
  storePath: string;
}): { provider: string; model: string } | undefined {
  const liveModel = resolveProjectedAgentRunModel({
    agentId: params.agentId,
    sessionId: params.sessionId,
    index: params.projectedAgentRuns,
  });
  if (params.active ?? liveModel !== undefined) {
    return liveModel ?? undefined;
  }
  if (!params.entry?.fallbackNotice) {
    return undefined;
  }
  const { selectedModel } = params;

  const fallbackEntry =
    params.activeModel === undefined
      ? readSessionFallbackModel({
          selectedProvider: selectedModel.provider,
          selectedModel: selectedModel.model,
          sessionEntry: params.entry,
          config: params.cfg,
          terminalModel: params.terminalModel ?? null,
          sessionScope: {
            agentId: params.storeAgentId ?? params.agentId,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
          },
        })
      : params.activeModel
        ? { modelProvider: params.activeModel.provider, model: params.activeModel.model }
        : undefined;
  const { selected, active } = resolveSelectedAndActiveModel({
    selectedProvider: selectedModel.provider,
    selectedModel: selectedModel.model,
    sessionEntry: fallbackEntry ?? params.entry,
  });
  return resolveActiveFallbackState({
    selectedModelRef: selected.label,
    activeModelRef: active.label,
    config: params.cfg,
    state: params.entry,
  }).active
    ? { provider: active.provider, model: active.model }
    : undefined;
}
