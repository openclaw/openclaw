import { AGENT_MODEL_CONFIG_KEYS } from "@openclaw/model-catalog-core/configured-model-refs";
import { asOptionalRecord as asMutableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { ensureRecord } from "../../../config/legacy.shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { listMutableCodexRouteAgentEntries } from "./codex-route-agent-entries.js";
import {
  modelRefUsesCodexRuntime,
  readModelConfigPrimaryRef,
  resolveImplicitDefaultAgentModelRef,
  resolveRuntimeModelRef,
  type LegacyCodexModelIdentity,
} from "./codex-route-model-ref.js";
import {
  collectCodexRuntimeModelPolicyRefs,
  collectModelConfigRefs,
  collectModelConfigSlot,
  collectStringModelConfigRef,
  collectStringModelSlot,
  recordCodexModelHit,
  visitChannelModelSlots,
  visitNonAgentModelSlots,
} from "./codex-route-model-slots.js";
import type {
  CodexRouteHit,
  CodexRuntimeRouteHit,
  DisabledCodexPluginRouteIssue,
} from "./codex-route-types.js";

function collectModelsMapRefs(params: {
  hits: CodexRouteHit[];
  path: string;
  models: unknown;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): void {
  const record = asMutableRecord(params.models);
  if (!record) {
    return;
  }
  for (const modelRef of Object.keys(record)) {
    recordCodexModelHit({
      ...params,
      path: `${params.path}.${modelRef}`,
      model: modelRef,
    });
  }
}

function collectModelPolicyAllowRefs(params: {
  hits: CodexRouteHit[];
  path: string;
  modelPolicy: unknown;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): void {
  const allow = asMutableRecord(params.modelPolicy)?.allow;
  if (!Array.isArray(allow)) {
    return;
  }
  for (const [index, modelRef] of allow.entries()) {
    collectStringModelSlot({
      ...params,
      path: `${params.path}.allow.${index}`,
      value: modelRef,
    });
  }
}

function collectAgentModelRefs(params: {
  hits: CodexRouteHit[];
  agent: unknown;
  path: string;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): void {
  const agent = asMutableRecord(params.agent);
  if (!agent) {
    return;
  }
  for (const key of AGENT_MODEL_CONFIG_KEYS) {
    collectModelConfigSlot({
      ...params,
      path: `${params.path}.${key}`,
      value: agent[key],
    });
  }
  const mediaModels = asMutableRecord(agent.mediaModels);
  for (const key of ["image", "video", "music"] as const) {
    collectModelConfigSlot({
      ...params,
      path: `${params.path}.mediaModels.${key}`,
      value: mediaModels?.[key],
    });
  }
  collectStringModelSlot({
    ...params,
    path: `${params.path}.heartbeat.model`,
    value: asMutableRecord(agent.heartbeat)?.model,
  });
  collectModelConfigSlot({
    ...params,
    path: `${params.path}.subagents.model`,
    value: asMutableRecord(agent.subagents)?.model,
  });
  const compaction = asMutableRecord(agent.compaction);
  collectStringModelSlot({
    ...params,
    path: `${params.path}.compaction.model`,
    value: compaction?.model,
  });
  collectStringModelSlot({
    ...params,
    path: `${params.path}.compaction.memoryFlush.model`,
    value: asMutableRecord(compaction?.memoryFlush)?.model,
  });
  collectModelsMapRefs({
    ...params,
    path: `${params.path}.models`,
    models: agent.models,
  });
  collectModelPolicyAllowRefs({
    ...params,
    path: `${params.path}.modelPolicy`,
    modelPolicy: agent.modelPolicy,
  });
}

export function collectConfigModelRefs(
  cfg: OpenClawConfig,
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
): CodexRouteHit[] {
  const hits: CodexRouteHit[] = [];
  const defaults = cfg.agents?.defaults;
  collectAgentModelRefs({
    hits,
    agent: defaults,
    path: "agents.defaults",
    blockedModelIdentities,
  });

  const agents = listMutableCodexRouteAgentEntries(cfg);
  for (const { agent: agentRecord, path } of agents) {
    collectAgentModelRefs({
      hits,
      agent: agentRecord,
      path,
      blockedModelIdentities,
    });
  }

  visitNonAgentModelSlots(cfg, ({ container, key, path }) => {
    collectStringModelSlot({ hits, path, value: container[key], blockedModelIdentities });
  });
  return hits;
}

export function collectDisabledCodexPluginRouteHits(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): CodexRuntimeRouteHit[] {
  return isCodexPluginUnavailableByConfig(cfg) ? collectCodexRuntimeRouteHits(cfg, env) : [];
}

/** Find effective configured model routes that select the Codex runtime. */
export function collectCodexRuntimeRouteHits(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): CodexRuntimeRouteHit[] {
  const defaults = cfg.agents?.defaults;
  const defaultRefs = collectAgentRuntimeModelRefs({
    agent: defaults,
    path: "agents.defaults",
  });
  let implicitDefaultRef: { path: string; modelRef: string } | undefined;
  if (
    cfg.agents &&
    !hasAgentPrimaryModelConfig(defaults) &&
    !defaultRefs.some(
      (ref) =>
        resolveRuntimeModelRef({ cfg, modelRef: ref.modelRef }) ===
        resolveImplicitDefaultAgentModelRef(cfg),
    )
  ) {
    implicitDefaultRef = {
      path: "agents.defaults.model",
      modelRef: resolveImplicitDefaultAgentModelRef(cfg),
    };
    defaultRefs.push(implicitDefaultRef);
  }

  const agents = listMutableCodexRouteAgentEntries(cfg);
  const inheritedDefaultAuxRefs = defaultRefs.filter(
    (ref) =>
      ref.path === "agents.defaults.heartbeat.model" ||
      ref.path.startsWith("agents.defaults.subagents.model"),
  );
  const inheritedDefaultModelPolicyRefs = defaultRefs.filter((ref) =>
    ref.path.startsWith("agents.defaults.models."),
  );
  const inheritedDefaultModelRefs = defaultRefs.filter(
    (ref) =>
      !inheritedDefaultAuxRefs.includes(ref) && !inheritedDefaultModelPolicyRefs.includes(ref),
  );
  const channelRefs = collectChannelAgentRuntimeModelRefs(cfg);
  const candidateRefs: Array<{ path: string; modelRef: string; agentId?: string }> =
    agents.length === 0 ? [...defaultRefs, ...channelRefs] : [];
  for (const { agent: agentRecord, agentId, path } of agents) {
    for (const ref of channelRefs) {
      candidateRefs.push({ path: ref.path, modelRef: ref.modelRef, agentId });
    }
    const inheritedModelRefs = inheritedDefaultAuxRefs.filter((ref) => {
      if (ref.path === "agents.defaults.heartbeat.model") {
        return !normalizeString(asMutableRecord(agentRecord.heartbeat)?.model);
      }
      if (ref.path.startsWith("agents.defaults.subagents.model")) {
        return !readModelConfigPrimaryRef(asMutableRecord(agentRecord.subagents)?.model);
      }
      return true;
    });
    inheritedModelRefs.push(...inheritedDefaultModelPolicyRefs);
    for (const ref of collectAgentRuntimeModelRefs({
      agent: agentRecord,
      path,
      fallbackModelRefs: inheritedDefaultModelRefs.map((inheritedRef) =>
        inheritedRef === implicitDefaultRef
          ? Object.assign({}, inheritedRef, {
              modelRef: resolveImplicitDefaultAgentModelRef(cfg, agentId),
            })
          : inheritedRef,
      ),
      inheritedModelRefs,
    })) {
      candidateRefs.push({ ...ref, agentId });
    }
  }

  const hits: CodexRuntimeRouteHit[] = [];
  const seen = new Set<string>();
  for (const ref of candidateRefs) {
    const canonicalModel = resolveRuntimeModelRef({
      cfg,
      modelRef: ref.modelRef,
      agentId: ref.agentId,
    });
    if (
      !modelRefUsesCodexRuntime({
        cfg,
        modelRef: ref.modelRef,
        agentId: ref.agentId,
        env,
      })
    ) {
      continue;
    }
    const key = `${ref.agentId ?? ""}\0${ref.path}\0${canonicalModel}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    hits.push({
      path: ref.path,
      modelRef: ref.modelRef,
      canonicalModel,
      ...(ref.agentId ? { agentId: ref.agentId } : {}),
    });
  }
  return hits;
}

/** Find Codex-routed model refs that require the Codex plugin while it is disabled. */
export function collectDisabledCodexPluginRouteIssues(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): DisabledCodexPluginRouteIssue[] {
  const repairBlocked = codexPluginRepairIsBlocked(cfg);
  return collectDisabledCodexPluginRouteHits(cfg, env).map((hit) => ({
    path: hit.path,
    modelRef: hit.modelRef,
    canonicalModel: hit.canonicalModel,
    repairBlocked,
  }));
}

export function enableCodexPluginForRequiredRoutes(params: {
  cfg: OpenClawConfig;
  routeHits: CodexRuntimeRouteHit[];
}): { cfg: OpenClawConfig; changes: string[] } {
  // Explicit user opt-out wins over managed-harness repair; doctor warns instead.
  if (params.routeHits.length === 0 || codexPluginRepairIsBlocked(params.cfg)) {
    return { cfg: params.cfg, changes: [] };
  }
  const cfg = structuredClone(params.cfg);
  const plugins = ensureRecord(cfg, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const codexEntry = asMutableRecord(entries.codex) ?? {};
  const changes: string[] = [];
  if (codexEntry.enabled !== true) {
    entries.codex = { ...codexEntry, enabled: true };
    changes.push(
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
    );
  } else if (entries.codex !== codexEntry) {
    entries.codex = codexEntry;
  }
  if (
    Array.isArray(plugins.allow) &&
    plugins.allow.length > 0 &&
    !plugins.allow.some((id) => normalizeString(id) === "codex")
  ) {
    plugins.allow = [...plugins.allow, "codex"];
    changes.push("Added codex to plugins.allow because configured agent routes use Codex runtime.");
  }
  return { cfg, changes };
}

export function codexPluginRepairIsBlocked(cfg: OpenClawConfig): boolean {
  return (
    cfg.plugins?.enabled === false ||
    pluginIdListIncludes(cfg.plugins?.deny, "codex") ||
    asMutableRecord(asMutableRecord(cfg.plugins?.entries)?.codex)?.enabled === false
  );
}

function isCodexPluginUnavailableByConfig(cfg: OpenClawConfig): boolean {
  if (codexPluginRepairIsBlocked(cfg)) {
    return true;
  }
  const allow = cfg.plugins?.allow;
  return Array.isArray(allow) && allow.length > 0 && !pluginIdListIncludes(allow, "codex");
}

function pluginIdListIncludes(value: unknown, pluginId: string): boolean {
  return Array.isArray(value) && value.some((entry) => normalizeString(entry) === pluginId);
}

function collectAgentRuntimeModelRefs(params: {
  agent: unknown;
  path: string;
  fallbackModelRefs?: ReadonlyArray<{ path: string; modelRef: string }>;
  inheritedModelRefs?: ReadonlyArray<{ path: string; modelRef: string }>;
}): Array<{ path: string; modelRef: string }> {
  const refs: Array<{ path: string; modelRef: string }> = [];
  const agent = asMutableRecord(params.agent);
  if (agent && Object.hasOwn(agent, "model")) {
    collectModelConfigRefs({ refs, path: `${params.path}.model`, value: agent.model });
  }
  if (!hasAgentPrimaryModelConfig(agent) && params.fallbackModelRefs) {
    refs.push(...params.fallbackModelRefs);
  }
  collectStringModelConfigRef({
    refs,
    path: `${params.path}.heartbeat.model`,
    value: asMutableRecord(agent?.heartbeat)?.model,
  });
  collectModelConfigRefs({
    refs,
    path: `${params.path}.subagents.model`,
    value: asMutableRecord(agent?.subagents)?.model,
  });
  if (params.inheritedModelRefs) {
    refs.push(...params.inheritedModelRefs);
  }
  collectCodexRuntimeModelPolicyRefs({
    refs,
    path: `${params.path}.models`,
    models: agent?.models,
  });
  return refs;
}

function hasAgentPrimaryModelConfig(agent: unknown): boolean {
  const record = asMutableRecord(agent);
  return Boolean(record && readModelConfigPrimaryRef(record.model));
}

function collectChannelAgentRuntimeModelRefs(
  cfg: OpenClawConfig,
): Array<{ path: string; modelRef: string }> {
  const refs: Array<{ path: string; modelRef: string }> = [];
  visitChannelModelSlots(cfg, ({ container, key, path }) => {
    collectStringModelConfigRef({ refs, path, value: container[key] });
  });
  return refs;
}
