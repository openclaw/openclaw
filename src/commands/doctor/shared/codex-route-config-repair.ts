import { AGENT_MODEL_CONFIG_KEYS } from "@openclaw/model-catalog-core/configured-model-refs";
import { asOptionalRecord as asMutableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import { ensureRecord } from "../../../config/legacy.shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { listMutableCodexRouteAgentEntries } from "./codex-route-agent-entries.js";
import {
  canAutoMigrateLegacyLosslessCompaction,
  collectLegacyLosslessCompactionConfigs,
  COMPACTION_OVERRIDE_KEYS,
  getSharedDefaultCompactionOverrideConsumers,
  legacyLosslessSummaryModels,
  LOSSLESS_CONTEXT_ENGINE_ID,
  readLosslessSummaryModel,
  sharedDefaultLosslessCompactionHasNonCodexConsumer,
} from "./codex-route-compaction-scan.js";
import {
  agentUsesCodexRuntimeForCompaction,
  isOpenAICodexModelRef,
  readAgentPrimaryModelRef,
  toCanonicalOpenAIModelRef,
  type LegacyCodexModelIdentity,
} from "./codex-route-model-ref.js";
import {
  recordCodexModelHit,
  rewriteModelConfigSlot,
  rewriteModelsMap,
  rewriteStringModelSlot,
  visitNonAgentModelSlots,
} from "./codex-route-model-slots.js";
import {
  agentIdFromAgentPath,
  ensureCodexRuntimePolicy,
  rewriteModelConfigSlotIfCanonicalCodexRuntime,
  rewriteStringModelSlotIfCanonicalCodexRuntime,
} from "./codex-route-runtime-policy.js";
import type {
  CodexRouteHit,
  CompactionOverrideKey,
  ConfigRouteRepairResult,
  LegacyLosslessCompactionConfig,
  MutableRecord,
  SharedDefaultCompactionOverrideConsumers,
} from "./codex-route-types.js";

function rewriteModelPolicyAllowRefs(params: {
  hits: CodexRouteHit[];
  agent: MutableRecord;
  path: string;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): void {
  const modelPolicy = asMutableRecord(params.agent.modelPolicy);
  if (!Array.isArray(modelPolicy?.allow)) {
    return;
  }
  modelPolicy.allow = modelPolicy.allow.map((entry, index) => {
    if (typeof entry !== "string") {
      return entry;
    }
    return (
      recordCodexModelHit({
        hits: params.hits,
        path: `${params.path}.modelPolicy.allow.${index}`,
        model: entry.trim(),
        blockedModelIdentities: params.blockedModelIdentities,
      }) ?? entry
    );
  });
}

function rewriteAgentModelRefs(
  params: Omit<Parameters<typeof rewriteAgentCompactionRefs>[0], "agent"> & {
    agent: MutableRecord | undefined;
  },
): void {
  if (!params.agent) {
    return;
  }
  const context = { ...params, agent: params.agent };
  for (const key of AGENT_MODEL_CONFIG_KEYS) {
    const start = params.hits.length;
    const rewrite =
      key === "model" ? rewriteModelConfigSlot : rewriteModelConfigSlotIfCanonicalCodexRuntime;
    rewrite({
      ...context,
      container: params.agent,
      key,
      path: `${params.path}.${key}`,
    });
    if (key === "model") {
      preserveCodexRuntimePolicyForHits(context, start);
    }
  }
  rewriteStringModelSlotIfCanonicalCodexRuntime({
    ...context,
    container: asMutableRecord(params.agent.heartbeat),
    key: "model",
    path: `${params.path}.heartbeat.model`,
  });
  rewriteModelConfigSlotIfCanonicalCodexRuntime({
    ...context,
    container: asMutableRecord(params.agent.subagents),
    key: "model",
    path: `${params.path}.subagents.model`,
  });
  rewriteAgentCompactionRefs(context);
  const mediaModels = asMutableRecord(params.agent.mediaModels);
  for (const key of ["image", "video", "music"] as const) {
    rewriteModelConfigSlot({
      ...context,
      container: mediaModels ?? {},
      key,
      path: `${params.path}.mediaModels.${key}`,
    });
  }
  const modelPolicyStart = params.hits.length;
  rewriteModelPolicyAllowRefs(context);
  preserveCodexRuntimePolicyForHits(context, modelPolicyStart);
  const modelsStart = params.hits.length;
  rewriteModelsMap({
    ...context,
    models: asMutableRecord(params.agent.models),
    path: `${params.path}.models`,
  });
  preserveCodexRuntimePolicyForHits(context, modelsStart);
}

export function rewriteConfigModelRefs(params: {
  cfg: OpenClawConfig;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  env?: NodeJS.ProcessEnv;
}): ConfigRouteRepairResult {
  const preserveSharedDefaultCompactionOverrides =
    getSharedDefaultCompactionOverrideConsumers(params);
  const nextConfig = structuredClone(params.cfg);
  const hits: CodexRouteHit[] = [];
  const runtimePolicyChanges: string[] = [];
  const unsupportedCompactionChanges = maybeMigrateLegacyLosslessCompactionConfig({
    cfg: nextConfig,
    env: params.env,
  });
  const preservedLegacyLosslessCompactionPaths = new Set(
    collectLegacyLosslessCompactionConfigs({
      cfg: nextConfig,
      env: params.env,
    }).flatMap((hit) => (hit.modelPath ? [hit.providerPath, hit.modelPath] : [hit.providerPath])),
  );
  const rewrittenInheritedCompactionModels = new Map<string, string>();
  const context = {
    ...params,
    cfg: nextConfig,
    preRepairCfg: params.cfg,
    hits,
    preserveUnsupportedCompactionPaths: preservedLegacyLosslessCompactionPaths,
    rewrittenInheritedCompactionModels,
    runtimePolicyChanges,
    unsupportedCompactionChanges,
  };
  rewriteAgentModelRefs({
    ...context,
    agent: asMutableRecord(nextConfig.agents?.defaults),
    path: "agents.defaults",
    preserveUnsupportedCompactionOverrides: preserveSharedDefaultCompactionOverrides,
  });
  const inheritedModelRef = readAgentPrimaryModelRef(nextConfig.agents?.defaults);
  const agents = listMutableCodexRouteAgentEntries(nextConfig);
  for (const { agent: agentRecord, agentId, path } of agents) {
    rewriteAgentModelRefs({
      ...context,
      agent: agentRecord,
      path,
      agentId,
      inheritedModelRef,
      inheritedCompaction: nextConfig.agents?.defaults?.compaction,
      inheritedCompactionPath: "agents.defaults.compaction",
    });
  }
  visitNonAgentModelSlots(nextConfig, (slot) => {
    rewriteStringModelSlotIfCanonicalCodexRuntime({ ...params, cfg: nextConfig, hits, ...slot });
  });
  return {
    cfg:
      hits.length > 0 || runtimePolicyChanges.length > 0 || unsupportedCompactionChanges.length > 0
        ? nextConfig
        : params.cfg,
    changes: hits,
    runtimePolicyChanges,
    unsupportedCompactionChanges,
  };
}

function rewriteAgentCompactionRefs(params: {
  cfg: OpenClawConfigWithLegacyRoster;
  preRepairCfg: OpenClawConfigWithLegacyRoster;
  hits: CodexRouteHit[];
  agent: MutableRecord;
  path: string;
  agentId?: string;
  inheritedModelRef?: string;
  inheritedCompaction?: unknown;
  inheritedCompactionPath?: string;
  preserveUnsupportedCompactionOverrides?: SharedDefaultCompactionOverrideConsumers;
  preserveUnsupportedCompactionPaths?: ReadonlySet<string>;
  rewrittenInheritedCompactionModels?: Map<string, string>;
  runtimePolicyChanges: string[];
  unsupportedCompactionChanges: string[];
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  env?: NodeJS.ProcessEnv;
}): void {
  const compaction = asMutableRecord(params.agent.compaction);
  const inheritedCompaction = asMutableRecord(params.inheritedCompaction);
  const usesCodexCompaction = agentUsesCodexRuntimeForCompaction(params);
  if (!usesCodexCompaction) {
    rewriteStringModelSlotIfCanonicalCodexRuntime({
      ...params,
      container: compaction,
      key: "model",
      path: `${params.path}.compaction.model`,
    });
  } else if (
    normalizeString(compaction?.provider ?? inheritedCompaction?.provider) ===
    LOSSLESS_CONTEXT_ENGINE_ID
  ) {
    rewriteLosslessCompactionModel(params, compaction, inheritedCompaction);
  } else {
    removeUnsupportedCodexCompactionOverrides({
      agent: params.agent,
      compaction,
      path: params.path,
      preserve: params.preserveUnsupportedCompactionOverrides,
      preservePaths: params.preserveUnsupportedCompactionPaths,
      changes: params.unsupportedCompactionChanges,
    });
    if (params.preserveUnsupportedCompactionOverrides?.model) {
      rewriteStringModelSlot({
        ...params,
        container: compaction,
        key: "model",
        path: `${params.path}.compaction.model`,
      });
    }
  }
  rewriteStringModelSlotIfCanonicalCodexRuntime({
    ...params,
    container: asMutableRecord(compaction?.memoryFlush),
    key: "model",
    path: `${params.path}.compaction.memoryFlush.model`,
  });
}

function rewriteLosslessCompactionModel(
  params: Parameters<typeof rewriteAgentCompactionRefs>[0],
  compaction: MutableRecord | undefined,
  inheritedCompaction: MutableRecord | undefined,
): void {
  const start = params.hits.length;
  rewriteStringModelSlot({
    ...params,
    container: compaction,
    key: "model",
    path: `${params.path}.compaction.model`,
  });
  preserveCodexRuntimePolicyForHits(params, start);

  const localModel = typeof compaction?.model === "string" ? compaction.model.trim() : "";
  const inheritedModelPath = params.inheritedCompactionPath
    ? `${params.inheritedCompactionPath}.model`
    : undefined;
  if (
    localModel ||
    !inheritedModelPath ||
    !params.preserveUnsupportedCompactionPaths?.has(inheritedModelPath)
  ) {
    return;
  }
  const inheritedStart = params.hits.length;
  rewriteStringModelSlot({
    ...params,
    container: inheritedCompaction,
    key: "model",
    path: inheritedModelPath,
  });
  const inheritedHit = params.hits[inheritedStart];
  const inheritedCanonicalModel =
    inheritedHit?.canonicalModel ??
    params.rewrittenInheritedCompactionModels?.get(inheritedModelPath);
  if (inheritedHit) {
    params.rewrittenInheritedCompactionModels?.set(inheritedModelPath, inheritedHit.canonicalModel);
    preserveCodexRuntimePolicyForHits(params, inheritedStart);
  } else if (inheritedCanonicalModel) {
    ensureCodexRuntimePolicy({
      ...params,
      agentPath: params.path,
      modelRef: inheritedCanonicalModel,
      changes: params.runtimePolicyChanges,
    });
  }
}

function preserveCodexRuntimePolicyForHits(
  params: Parameters<typeof rewriteAgentCompactionRefs>[0],
  fromIndex: number,
): void {
  for (const hit of params.hits.slice(fromIndex)) {
    ensureCodexRuntimePolicy({
      ...params,
      agentPath: params.path,
      modelRef: hit.canonicalModel,
      legacyModelRef: hit.model,
      changes: params.runtimePolicyChanges,
    });
  }
}

function removeUnsupportedCodexCompactionOverrides(params: {
  agent: MutableRecord;
  compaction: MutableRecord | undefined;
  path: string;
  preserve?: Partial<Record<CompactionOverrideKey, boolean>>;
  preservePaths?: ReadonlySet<string>;
  changes: string[];
}): void {
  if (!params.compaction) {
    return;
  }
  if (normalizeString(params.compaction.provider) === LOSSLESS_CONTEXT_ENGINE_ID) {
    return;
  }
  for (const key of COMPACTION_OVERRIDE_KEYS) {
    const path = `${params.path}.compaction.${key}`;
    if (params.preservePaths?.has(path) || params.preserve?.[key]) {
      continue;
    }
    const value = params.compaction[key];
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    delete params.compaction[key];
    params.changes.push(`Removed ${path}; Codex runtime uses native server-side compaction.`);
  }
  if (Object.keys(params.compaction).length === 0) {
    delete params.agent.compaction;
  }
}

function maybeMigrateLegacyLosslessCompactionConfig(params: {
  cfg: OpenClawConfigWithLegacyRoster;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const root: MutableRecord = params.cfg;
  const hits = collectLegacyLosslessCompactionConfigs(params);
  if (hits.length === 0) {
    return [];
  }
  const existingPlugins = asMutableRecord(root.plugins);
  const existingSlots = asMutableRecord(existingPlugins?.slots);
  const configuredContextEngine =
    typeof existingSlots?.contextEngine === "string" && existingSlots.contextEngine.trim()
      ? existingSlots.contextEngine.trim()
      : undefined;
  const existingSummaryModel = readLosslessSummaryModel(existingPlugins);
  const contextEngine = normalizeString(configuredContextEngine);
  if (
    sharedDefaultLosslessCompactionHasNonCodexConsumer(params) ||
    !canAutoMigrateLegacyLosslessCompaction({
      hits,
      contextEngine,
      summaryModel: existingSummaryModel,
    })
  ) {
    return [];
  }
  const plugins = ensureRecord(root, "plugins");
  const slots = ensureRecord(plugins, "slots");
  const entries = ensureRecord(plugins, "entries");
  const entry = ensureRecord(entries, LOSSLESS_CONTEXT_ENGINE_ID);
  const config = ensureRecord(entry, "config");
  const changes: string[] = [];
  if (slots.contextEngine !== LOSSLESS_CONTEXT_ENGINE_ID) {
    slots.contextEngine = LOSSLESS_CONTEXT_ENGINE_ID;
    changes.push(
      `Set plugins.slots.contextEngine to "${LOSSLESS_CONTEXT_ENGINE_ID}" for legacy Lossless compaction config.`,
    );
  }
  if (entry.enabled !== true) {
    entry.enabled = true;
    changes.push(`Enabled plugins.entries.${LOSSLESS_CONTEXT_ENGINE_ID}.`);
  }
  let summaryModel = existingSummaryModel;
  const firstModel = legacyLosslessSummaryModels(hits)[0];
  if (!summaryModel && firstModel) {
    summaryModel = firstModel;
    config.summaryModel = summaryModel;
    changes.push(
      `Moved ${hits.find((hit) => hit.modelValue)?.modelPath ?? "legacy compaction model"} to plugins.entries.${LOSSLESS_CONTEXT_ENGINE_ID}.config.summaryModel.`,
    );
  }
  ensureLosslessLlmPolicy({ entry, summaryModel, changes });
  preserveMigratedLosslessCodexRuntimePolicy({
    ...params,
    hits,
    summaryModel,
    changes,
  });
  for (const hit of hits) {
    for (const key of ["provider", "model"] as const) {
      const path = key === "provider" ? hit.providerPath : hit.modelPath;
      if (!path) {
        continue;
      }
      const owner = readCompactionOwnerForPath(params.cfg, readCompactionOwnerPathForKeyPath(path));
      const compaction = asMutableRecord(owner?.compaction);
      const value = compaction?.[key];
      if (!owner || !compaction || typeof value !== "string" || !value.trim()) {
        continue;
      }
      delete compaction[key];
      changes.push(
        key === "provider"
          ? `Removed ${path}; Lossless now runs through plugins.slots.contextEngine.`
          : `Removed ${path} after migrating the Lossless summary model.`,
      );
      if (Object.keys(compaction).length === 0) {
        delete owner.compaction;
      }
    }
  }
  return changes;
}

function preserveMigratedLosslessCodexRuntimePolicy(
  params: Parameters<typeof maybeMigrateLegacyLosslessCompactionConfig>[0] & {
    hits: readonly LegacyLosslessCompactionConfig[];
    summaryModel: string | undefined;
    changes: string[];
  },
): void {
  if (!params.summaryModel) {
    return;
  }
  const preservedOwners = new Set<string>();
  for (const hit of params.hits) {
    if (!hit.modelValue || !isOpenAICodexModelRef(hit.modelValue)) {
      continue;
    }
    const canonicalModel = toCanonicalOpenAIModelRef(hit.modelValue);
    if (canonicalModel !== params.summaryModel) {
      continue;
    }
    const ownerPath = readCompactionOwnerPathForKeyPath(hit.modelPath ?? hit.providerPath);
    if (preservedOwners.has(ownerPath)) {
      continue;
    }
    const owner = readCompactionOwnerForPath(params.cfg, ownerPath);
    if (!owner) {
      continue;
    }
    preservedOwners.add(ownerPath);
    ensureCodexRuntimePolicy({
      ...params,
      agent: owner,
      agentPath: ownerPath,
      agentId: agentIdFromAgentPath(ownerPath),
      modelRef: params.summaryModel,
    });
  }
}

function ensureLosslessLlmPolicy(params: {
  entry: MutableRecord;
  summaryModel: string | undefined;
  changes: string[];
}): void {
  if (!params.summaryModel) {
    return;
  }
  const llm = ensureRecord(params.entry, "llm");
  if (llm.allowModelOverride !== true) {
    llm.allowModelOverride = true;
    params.changes.push(
      `Set plugins.entries.${LOSSLESS_CONTEXT_ENGINE_ID}.llm.allowModelOverride to true for Lossless summary model overrides.`,
    );
  }
  const allowedModels = Array.isArray(llm.allowedModels) ? [...llm.allowedModels] : [];
  if (!allowedModels.includes(params.summaryModel)) {
    allowedModels.push(params.summaryModel);
    llm.allowedModels = allowedModels;
    params.changes.push(
      `Added ${params.summaryModel} to plugins.entries.${LOSSLESS_CONTEXT_ENGINE_ID}.llm.allowedModels.`,
    );
  }
}

function readCompactionOwnerForPath(
  cfg: OpenClawConfigWithLegacyRoster,
  ownerPath: string,
): MutableRecord | undefined {
  if (ownerPath === "agents.defaults") {
    return asMutableRecord(cfg.agents?.defaults);
  }
  const prefix = "agents.list.";
  if (!ownerPath.startsWith(prefix)) {
    return readMutablePath(cfg, ownerPath);
  }
  const label = ownerPath.slice(prefix.length);
  const agents = cfg.agents?.list ?? [];
  return (
    asMutableRecord(agents.find((agent) => agent.id === label)) ??
    asMutableRecord(Number.isInteger(Number(label)) ? agents[Number(label)] : undefined)
  );
}

function readMutablePath(root: MutableRecord, pathLabel: string): MutableRecord | undefined {
  let cursor: unknown = root;
  for (const part of pathLabel.split(".")) {
    const record = asMutableRecord(cursor);
    if (!record) {
      return undefined;
    }
    cursor = record[part];
  }
  return asMutableRecord(cursor);
}

function readCompactionOwnerPathForKeyPath(path: string): string {
  return path.replace(/\.(model|provider)$/, "").replace(/\.compaction$/, "");
}
