import { resolveContextTokensForModel } from "../agents/context.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  parseModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
} from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";

function resolveConfiguredStatusModelRef(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultModel: string;
  agentId?: string;
}): { provider: string; model: string } {
  if (params.agentId) {
    return resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
    });
  }
  return resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });
}

function classifySessionKey(key: string, entry?: SessionEntry) {
  if (key === "global") {
    return "global";
  }
  if (key === "unknown") {
    return "unknown";
  }
  if (entry?.chatType === "group" || entry?.chatType === "channel") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    return "group";
  }
  return "direct";
}

function resolveSessionModelRef(
  cfg: OpenClawConfig,
  entry?:
    | SessionEntry
    | Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride">,
  agentId?: string,
): { provider: string; model: string } {
  const resolved = resolveConfiguredStatusModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    agentId,
  });

  let provider = resolved.provider;
  let model = resolved.model;
  const runtimeModel = entry?.model?.trim();
  const runtimeProvider = entry?.modelProvider?.trim();
  if (runtimeModel) {
    if (runtimeProvider) {
      return { provider: runtimeProvider, model: runtimeModel };
    }
    const parsedRuntime = parseModelRef(runtimeModel, provider || DEFAULT_PROVIDER);
    if (parsedRuntime) {
      provider = parsedRuntime.provider;
      model = parsedRuntime.model;
    } else {
      model = runtimeModel;
    }
    return { provider, model };
  }

  const storedModelOverride = entry?.modelOverride?.trim();
  if (storedModelOverride) {
    const overrideProvider = entry?.providerOverride?.trim() || provider || DEFAULT_PROVIDER;
    const parsedOverride = parseModelRef(storedModelOverride, overrideProvider);
    if (parsedOverride) {
      provider = parsedOverride.provider;
      model = parsedOverride.model;
    } else {
      provider = overrideProvider;
      model = storedModelOverride;
    }
  }
  return { provider, model };
}

export const statusSummaryRuntime = {
  resolveContextTokensForModel,
  classifySessionKey,
  resolveSessionModelRef,
  resolveConfiguredStatusModelRef,
};
