import type { OpenClawConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import {
  applyVllmDefaultModel,
  clearStaleVllmDefaultModel,
  clearStaleVllmModelConfig,
  isStaleManagedVllmModelRef,
} from "./vllm-default-model.js";
import { promptAndConfigureVllm } from "./vllm-setup.js";

function resolveAgentModelRef(config: OpenClawConfig, agentId?: string): string | undefined {
  const normalizedAgentId = agentId ? normalizeAgentId(agentId) : undefined;
  if (!normalizedAgentId) {
    return undefined;
  }

  const entry = config.agents?.list?.find(
    (candidate) => normalizeAgentId(candidate.id) === normalizedAgentId,
  );
  if (!entry?.model) {
    return undefined;
  }

  if (typeof entry.model === "string") {
    return entry.model.trim() || undefined;
  }

  return entry.model.primary?.trim() || undefined;
}

function pruneCurrentAgentModelOverride(params: {
  config: OpenClawConfig;
  agentId?: string;
}): OpenClawConfig {
  const agentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  if (!agentId) {
    return params.config;
  }

  const list = params.config.agents?.list;
  if (!list || list.length === 0) {
    return params.config;
  }

  const index = list.findIndex(
    (candidate: NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number]) =>
      normalizeAgentId(candidate.id) === agentId,
  );
  if (index < 0) {
    return params.config;
  }

  const entry = list[index];
  const nextModel = clearStaleVllmModelConfig(params.config, entry.model);
  if (nextModel === entry.model) {
    return params.config;
  }

  const nextList = [...list];
  const nextEntry = { ...entry };
  if (nextModel) {
    nextEntry.model = nextModel;
  } else {
    delete nextEntry.model;
  }
  nextList[index] = nextEntry;

  return {
    ...params.config,
    agents: {
      ...params.config.agents,
      list: nextList,
    },
  };
}

function pruneAllAgentModelOverrides(config: OpenClawConfig): OpenClawConfig {
  const list = config.agents?.list;
  if (!list || list.length === 0) {
    return config;
  }

  let changed = false;
  const nextList = list.map((entry) => {
    const nextModel = clearStaleVllmModelConfig(config, entry.model);
    if (nextModel === entry.model) {
      return entry;
    }
    changed = true;
    if (!nextModel) {
      const { model: _model, ...restEntry } = entry;
      return restEntry;
    }
    return {
      ...entry,
      model: nextModel,
    };
  });

  if (!changed) {
    return config;
  }

  return {
    ...config,
    agents: {
      ...config.agents,
      list: nextList,
    },
  };
}

export async function applyAuthChoiceVllm(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "vllm") {
    return null;
  }

  const vllmSelection = await promptAndConfigureVllm({
    cfg: params.config,
    prompter: params.prompter,
    agentDir: params.agentDir,
  });

  if (!vllmSelection.modelRef) {
    const nextConfig = params.agentId
      ? pruneCurrentAgentModelOverride({
          config: clearStaleVllmDefaultModel(vllmSelection.config),
          agentId: params.agentId,
        })
      : pruneAllAgentModelOverrides(clearStaleVllmDefaultModel(vllmSelection.config));
    const shouldClearAgentModelOverride = isStaleManagedVllmModelRef(
      nextConfig,
      resolveAgentModelRef(nextConfig, params.agentId),
    );
    return {
      config: nextConfig,
      ...(shouldClearAgentModelOverride ? { clearAgentModelOverride: true } : {}),
    };
  }

  const { config: nextConfig, modelRef } = vllmSelection;

  if (!params.setDefaultModel) {
    return { config: nextConfig, agentModelOverride: modelRef };
  }

  await params.prompter.note(`Default model set to ${modelRef}`, "Model configured");
  return { config: applyVllmDefaultModel(nextConfig, modelRef) };
}
