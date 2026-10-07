import { asOptionalRecord as asMutableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { dedupeByKey } from "../../../shared/dedupe-by-key.js";
import { listMutableCodexRouteAgentEntries } from "./codex-route-agent-entries.js";
import {
  agentUsesCodexRuntimeForCompaction,
  normalizeDefaultProviderModelRef,
  readAgentPrimaryModelRef,
  toCanonicalOpenAIModelRef,
} from "./codex-route-model-ref.js";
import type {
  CompactionOverrideKey,
  LegacyLosslessCompactionConfig,
  MutableRecord,
  SharedDefaultCompactionOverrideConsumers,
  UnsupportedCodexCompactionOverride,
} from "./codex-route-types.js";

export const COMPACTION_OVERRIDE_KEYS: readonly CompactionOverrideKey[] = ["model", "provider"];
export const LOSSLESS_CONTEXT_ENGINE_ID = "lossless-claw";

type AgentCompactionScanParams = {
  cfg: OpenClawConfig;
  agent: unknown;
  path: string;
  agentId?: string;
  inheritedModelRef?: string;
  inheritedCompaction?: unknown;
  inheritedCompactionPath?: string;
  env?: NodeJS.ProcessEnv;
};

type CompactionScanParams = {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

function collectUnsupportedCodexCompactionOverridesForAgent(
  params: AgentCompactionScanParams,
): UnsupportedCodexCompactionOverride[] {
  const agent = asMutableRecord(params.agent);
  const compaction = asMutableRecord(agent?.compaction);
  const inheritedCompaction = asMutableRecord(params.inheritedCompaction);
  const providerValue = compaction?.provider ?? inheritedCompaction?.provider;
  if (normalizeString(providerValue) === LOSSLESS_CONTEXT_ENGINE_ID) {
    return [];
  }
  const candidates = COMPACTION_OVERRIDE_KEYS.map((key) => {
    const localValue = compaction?.[key];
    const hasLocalValue = typeof localValue === "string" && localValue.trim();
    return {
      key,
      value: hasLocalValue ? localValue : inheritedCompaction?.[key],
      path: hasLocalValue
        ? `${params.path}.compaction.${key}`
        : params.inheritedCompactionPath
          ? `${params.inheritedCompactionPath}.${key}`
          : `${params.path}.compaction.${key}`,
    };
  });
  return candidates.flatMap(({ key, path, value }) =>
    typeof value === "string" && value.trim() ? [{ path, key, value: value.trim() }] : [],
  );
}

function collectLegacyLosslessCompactionForAgent(
  params: AgentCompactionScanParams,
): LegacyLosslessCompactionConfig[] {
  const agent = asMutableRecord(params.agent);
  const compaction = asMutableRecord(agent?.compaction);
  const inheritedCompaction = asMutableRecord(params.inheritedCompaction);
  const localProvider = compaction?.provider;
  const hasLocalProvider = typeof localProvider === "string" && localProvider.trim();
  const providerValue = hasLocalProvider ? localProvider : inheritedCompaction?.provider;
  if (normalizeString(providerValue) !== LOSSLESS_CONTEXT_ENGINE_ID) {
    return [];
  }
  const compactionPath = hasLocalProvider
    ? `${params.path}.compaction`
    : (params.inheritedCompactionPath ?? `${params.path}.compaction`);
  const localModel = compaction?.model;
  const hasLocalModel = typeof localModel === "string" && localModel.trim();
  const inheritedModel = inheritedCompaction?.model;
  const modelValue = hasLocalModel ? localModel : inheritedModel;
  const modelCompactionPath = hasLocalModel
    ? `${params.path}.compaction`
    : (params.inheritedCompactionPath ?? compactionPath);
  return [
    {
      providerPath: `${compactionPath}.provider`,
      providerValue: String(providerValue).trim(),
      ...(typeof modelValue === "string" && modelValue.trim()
        ? {
            modelPath: `${modelCompactionPath}.model`,
            modelValue: modelValue.trim(),
          }
        : {}),
    },
  ];
}

function collectCompactionConfigs<T>(
  params: CompactionScanParams,
  collect: (params: AgentCompactionScanParams) => T[],
): T[] {
  const collectForAgent = (agentParams: AgentCompactionScanParams) =>
    agentUsesCodexRuntimeForCompaction({
      ...agentParams,
      agent: asMutableRecord(agentParams.agent),
    })
      ? collect(agentParams)
      : [];
  const defaults = params.cfg.agents?.defaults;
  const defaultModelRef = readAgentPrimaryModelRef(defaults);
  const defaultCompaction = asMutableRecord(defaults?.compaction);
  const hits = collectForAgent({
    cfg: params.cfg,
    agent: defaults,
    path: "agents.defaults",
    env: params.env,
  });
  for (const { agent: agentRecord, agentId: id, path } of listMutableCodexRouteAgentEntries(
    params.cfg,
  )) {
    hits.push(
      ...collectForAgent({
        cfg: params.cfg,
        agent: agentRecord,
        path,
        agentId: id,
        inheritedModelRef: defaultModelRef,
        inheritedCompaction: defaultCompaction,
        inheritedCompactionPath: "agents.defaults.compaction",
        env: params.env,
      }),
    );
  }
  return hits;
}

export function collectLegacyLosslessCompactionConfigs(
  params: CompactionScanParams,
): LegacyLosslessCompactionConfig[] {
  return dedupeByKey(
    collectCompactionConfigs(params, collectLegacyLosslessCompactionForAgent),
    (hit) =>
      `${hit.providerPath}\0${hit.providerValue}\0${hit.modelPath ?? ""}\0${hit.modelValue ?? ""}`,
  );
}

export function collectUnsupportedCodexCompactionOverrides(
  params: CompactionScanParams,
): UnsupportedCodexCompactionOverride[] {
  return dedupeByKey(
    collectCompactionConfigs(params, collectUnsupportedCodexCompactionOverridesForAgent),
    (hit) => `${hit.path}\0${hit.key}\0${hit.value}`,
  );
}

export function getSharedDefaultCompactionOverrideConsumers(
  params: CompactionScanParams,
): SharedDefaultCompactionOverrideConsumers {
  const consumers: SharedDefaultCompactionOverrideConsumers = { model: false, provider: false };
  const defaults = params.cfg.agents?.defaults;
  const defaultCompaction = asMutableRecord(defaults?.compaction);
  if (!defaultCompaction) {
    return consumers;
  }
  const hasDefaultModel =
    typeof defaultCompaction.model === "string" && defaultCompaction.model.trim();
  const hasDefaultProvider =
    typeof defaultCompaction.provider === "string" && defaultCompaction.provider.trim();
  if (!hasDefaultModel && !hasDefaultProvider) {
    return consumers;
  }
  const inheritedModelRef = readAgentPrimaryModelRef(defaults);
  const defaultUsesCodexCompaction = agentUsesCodexRuntimeForCompaction({
    cfg: params.cfg,
    agent: defaults,
    env: params.env,
  });
  if (!defaultUsesCodexCompaction) {
    return { model: Boolean(hasDefaultModel), provider: Boolean(hasDefaultProvider) };
  }
  for (const { agent: agentRecord, agentId: id } of listMutableCodexRouteAgentEntries(params.cfg)) {
    const compaction = asMutableRecord(agentRecord.compaction);
    const inheritsDefaultModel =
      Boolean(hasDefaultModel) &&
      !(typeof compaction?.model === "string" && compaction.model.trim());
    const inheritsDefaultProvider =
      Boolean(hasDefaultProvider) &&
      !(typeof compaction?.provider === "string" && compaction.provider.trim());
    if (!inheritsDefaultModel && !inheritsDefaultProvider) {
      continue;
    }
    const usesCodexCompaction = agentUsesCodexRuntimeForCompaction({
      cfg: params.cfg,
      agent: agentRecord,
      agentId: id,
      inheritedModelRef,
      env: params.env,
    });
    if (!usesCodexCompaction) {
      consumers.model ||= inheritsDefaultModel;
      consumers.provider ||= inheritsDefaultProvider;
      if ((!hasDefaultModel || consumers.model) && (!hasDefaultProvider || consumers.provider)) {
        break;
      }
    }
  }
  return consumers;
}

export function sharedDefaultLosslessCompactionHasNonCodexConsumer(
  params: CompactionScanParams,
): boolean {
  const defaults = params.cfg.agents?.defaults;
  const defaultCompaction = asMutableRecord(defaults?.compaction);
  const hasDefaultLosslessProvider =
    normalizeString(defaultCompaction?.provider) === LOSSLESS_CONTEXT_ENGINE_ID;
  const hasDefaultModel =
    typeof defaultCompaction?.model === "string" && defaultCompaction.model.trim();
  if (!hasDefaultLosslessProvider && !hasDefaultModel) {
    return false;
  }
  const consumers = getSharedDefaultCompactionOverrideConsumers(params);
  return (
    (hasDefaultLosslessProvider && consumers.provider) ||
    (Boolean(hasDefaultModel) && consumers.model)
  );
}

export function legacyLosslessSummaryModels(
  hits: readonly LegacyLosslessCompactionConfig[],
): string[] {
  const models = new Set<string>();
  for (const hit of hits) {
    if (!hit.modelValue) {
      continue;
    }
    models.add(
      toCanonicalOpenAIModelRef(hit.modelValue) ?? normalizeDefaultProviderModelRef(hit.modelValue),
    );
  }
  return [...models];
}

export function canAutoMigrateLegacyLosslessCompaction(params: {
  hits: readonly LegacyLosslessCompactionConfig[];
  contextEngine?: string;
  summaryModel?: string;
}): boolean {
  if (params.contextEngine && params.contextEngine !== LOSSLESS_CONTEXT_ENGINE_ID) {
    return false;
  }
  const models = legacyLosslessSummaryModels(params.hits);
  const hasProviderOnlyConsumer = params.hits.some((hit) => !hit.modelValue);
  if (hasProviderOnlyConsumer && (models.length > 0 || params.summaryModel)) {
    return false;
  }
  if (models.length === 0) {
    return true;
  }
  if (params.summaryModel) {
    return models.every((model) => model === params.summaryModel);
  }
  return models.length === 1;
}

export function readLosslessSummaryModel(plugins: MutableRecord | undefined): string | undefined {
  const entries = asMutableRecord(plugins?.entries);
  const entry = asMutableRecord(entries?.[LOSSLESS_CONTEXT_ENGINE_ID]);
  const config = asMutableRecord(entry?.config);
  return typeof config?.summaryModel === "string" && config.summaryModel.trim()
    ? config.summaryModel.trim()
    : undefined;
}
