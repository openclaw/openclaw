import { AGENT_MODEL_CONFIG_KEYS } from "@openclaw/model-catalog-core/configured-model-refs";
import { asOptionalRecord as asMutableRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { listMutableCodexRouteAgentEntries } from "./codex-route-agent-entries.js";
import {
  maybeMigrateLegacyLosslessCompactionConfig,
  rewriteAgentCompactionRefs,
} from "./codex-route-compaction-repair.js";
import {
  collectLegacyLosslessCompactionConfigs,
  getSharedDefaultCompactionOverrideConsumers,
} from "./codex-route-compaction-scan.js";
import {
  readAgentPrimaryModelRef,
  type LegacyCodexModelIdentity,
} from "./codex-route-model-ref.js";
import {
  recordCodexModelHit,
  rewriteModelConfigSlot,
  rewriteModelsMap,
  visitNonAgentModelSlots,
} from "./codex-route-model-slots.js";
import {
  ensureCodexRuntimePolicy,
  rewriteModelConfigSlotIfCanonicalCodexRuntime,
  rewriteStringModelSlotIfCanonicalCodexRuntime,
} from "./codex-route-runtime-policy.js";
import type { CodexRouteHit, ConfigRouteRepairResult, MutableRecord } from "./codex-route-types.js";

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
  const preserveCodexRuntimePolicyForNewHits = (fromIndex: number) => {
    for (const hit of params.hits.slice(fromIndex)) {
      ensureCodexRuntimePolicy({
        cfg: params.cfg,
        agent: params.agent!,
        agentPath: params.path,
        agentId: params.agentId,
        modelRef: hit.canonicalModel,
        legacyModelRef: hit.model,
        preRepairCfg: params.preRepairCfg,
        changes: params.runtimePolicyChanges,
        env: params.env,
      });
    }
  };
  for (const key of AGENT_MODEL_CONFIG_KEYS) {
    const start = params.hits.length;
    if (key === "model") {
      rewriteModelConfigSlot({
        ...params,
        container: params.agent,
        key,
        path: `${params.path}.${key}`,
      });
      preserveCodexRuntimePolicyForNewHits(start);
    } else {
      rewriteModelConfigSlotIfCanonicalCodexRuntime({
        ...params,
        container: params.agent,
        key,
        path: `${params.path}.${key}`,
      });
    }
  }
  rewriteStringModelSlotIfCanonicalCodexRuntime({
    ...params,
    container: asMutableRecord(params.agent.heartbeat),
    key: "model",
    path: `${params.path}.heartbeat.model`,
  });
  rewriteModelConfigSlotIfCanonicalCodexRuntime({
    ...params,
    container: asMutableRecord(params.agent.subagents),
    key: "model",
    path: `${params.path}.subagents.model`,
  });
  rewriteAgentCompactionRefs({
    ...params,
    agent: params.agent,
  });
  const mediaModels = asMutableRecord(params.agent.mediaModels);
  for (const key of ["image", "video", "music"] as const) {
    rewriteModelConfigSlot({
      ...params,
      container: mediaModels ?? {},
      key,
      path: `${params.path}.mediaModels.${key}`,
    });
  }
  const modelPolicyStart = params.hits.length;
  rewriteModelPolicyAllowRefs({
    ...params,
    agent: params.agent,
  });
  preserveCodexRuntimePolicyForNewHits(modelPolicyStart);
  const modelsStart = params.hits.length;
  rewriteModelsMap({
    ...params,
    models: asMutableRecord(params.agent.models),
    path: `${params.path}.models`,
  });
  preserveCodexRuntimePolicyForNewHits(modelsStart);
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
  const unsupportedCompactionChanges: string[] = [];
  unsupportedCompactionChanges.push(
    ...maybeMigrateLegacyLosslessCompactionConfig({
      cfg: nextConfig,
      env: params.env,
    }),
  );
  const preservedLegacyLosslessCompactionPaths = new Set(
    collectLegacyLosslessCompactionConfigs({
      cfg: nextConfig,
      env: params.env,
    }).flatMap((hit) => (hit.modelPath ? [hit.providerPath, hit.modelPath] : [hit.providerPath])),
  );
  const rewrittenInheritedCompactionModels = new Map<string, string>();
  rewriteAgentModelRefs({
    cfg: nextConfig,
    preRepairCfg: params.cfg,
    hits,
    agent: asMutableRecord(nextConfig.agents?.defaults),
    path: "agents.defaults",
    preserveUnsupportedCompactionOverrides: preserveSharedDefaultCompactionOverrides,
    preserveUnsupportedCompactionPaths: preservedLegacyLosslessCompactionPaths,
    rewrittenInheritedCompactionModels,
    runtimePolicyChanges,
    unsupportedCompactionChanges,
    blockedModelIdentities: params.blockedModelIdentities,
    env: params.env,
  });
  const inheritedModelRef = readAgentPrimaryModelRef(nextConfig.agents?.defaults);
  const agents = listMutableCodexRouteAgentEntries(nextConfig);
  for (const { agent: agentRecord, agentId, path } of agents) {
    rewriteAgentModelRefs({
      cfg: nextConfig,
      preRepairCfg: params.cfg,
      hits,
      agent: agentRecord,
      path,
      agentId,
      inheritedModelRef,
      inheritedCompaction: nextConfig.agents?.defaults?.compaction,
      inheritedCompactionPath: "agents.defaults.compaction",
      preserveUnsupportedCompactionPaths: preservedLegacyLosslessCompactionPaths,
      rewrittenInheritedCompactionModels,
      runtimePolicyChanges,
      unsupportedCompactionChanges,
      blockedModelIdentities: params.blockedModelIdentities,
      env: params.env,
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
