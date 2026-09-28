import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveMutableAgentEntry } from "../../../agents/agent-scope-config.js";
import { mergeAgentModelEntryForConfig } from "../../../config/model-input.js";
import type { AgentModelEntryConfig } from "../../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ModelRetirementScope } from "./retired-model-ref-repair.types.js";

type RetiredModelSettings<T> = {
  inheritedSource?: T;
  inheritedSuccessor?: T;
  source?: T;
  successor?: T;
  retainSource: boolean;
};

export function modelSettingsWithoutAlias(value: unknown): unknown {
  const record = asOptionalRecord(value);
  if (!record) {
    return value;
  }
  const { alias: _alias, ...settings } = record;
  return settings;
}

export function mergeRetiredModelSettings(
  params: RetiredModelSettings<AgentModelEntryConfig>,
): AgentModelEntryConfig | undefined;
export function mergeRetiredModelSettings(params: RetiredModelSettings<unknown>): unknown;
export function mergeRetiredModelSettings(params: RetiredModelSettings<unknown>): unknown {
  // Local source policy outranks inherited successor settings; an authored local successor wins.
  return [
    params.retainSource
      ? modelSettingsWithoutAlias(params.inheritedSource)
      : params.inheritedSource,
    params.inheritedSuccessor,
    params.retainSource ? modelSettingsWithoutAlias(params.source) : params.source,
    params.successor,
  ]
    .filter((value) => value !== undefined)
    .reduce<unknown>(mergeAgentModelEntryForConfig, undefined);
}

/** Read-only auth evaluation must see the settings the repair will preserve. */
export function projectRetiredModelSuccessorConfig(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sourceModelRef: string;
  successorModelRef: string;
  retirementScope: ModelRetirementScope;
  resolveModelRef: (modelRef: string) => string | undefined;
}): OpenClawConfig {
  const { cfg, agentId, sourceModelRef, successorModelRef } = params;
  const entry = resolveMutableAgentEntry(cfg, agentId);
  const inheritedModels = cfg.agents?.defaults?.models;
  const models = entry?.models;
  const retainSource = params.retirementScope === "route";
  let settings = models?.[successorModelRef];
  let matchedSource = false;
  // Follow the writer's authored-key order: inherited copies precede local moves.
  for (const [modelRef, inherited] of Object.entries(inheritedModels ?? {})) {
    if (params.resolveModelRef(modelRef) !== sourceModelRef) {
      continue;
    }
    matchedSource = true;
    settings = mergeRetiredModelSettings({
      inheritedSource: inherited,
      inheritedSuccessor: inheritedModels?.[successorModelRef],
      source: models?.[modelRef],
      successor: settings,
      retainSource,
    });
  }
  for (const [modelRef, source] of Object.entries(models ?? {})) {
    if (params.resolveModelRef(modelRef) !== sourceModelRef) {
      continue;
    }
    matchedSource = true;
    settings = mergeRetiredModelSettings({ source, successor: settings, retainSource });
  }
  if (!matchedSource || settings === undefined) {
    return cfg;
  }
  if (!entry) {
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          models: { ...inheritedModels, [successorModelRef]: settings },
        },
      },
    };
  }
  const projectedModels = { ...models, [successorModelRef]: settings };
  const agents = { ...cfg.agents };
  if (agents.entries) {
    agents.entries = { ...agents.entries };
    for (const [id, candidate] of Object.entries(agents.entries)) {
      if (candidate === entry) {
        agents.entries[id] = { ...candidate, models: projectedModels };
      }
    }
  } else if (agents.list) {
    agents.list = agents.list.slice();
    for (const [index, candidate] of agents.list.entries()) {
      if (candidate === entry) {
        agents.list[index] = { ...candidate, models: projectedModels };
      }
    }
  }
  return { ...cfg, agents };
}
