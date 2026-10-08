import { AGENT_MODEL_CONFIG_KEYS } from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asOptionalRecord as asMutableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalAgentRuntimeId } from "../../../agents/agent-runtime-id.js";
import { resolveModelRuntimePolicy } from "../../../agents/model-runtime-policy.js";
import { ensureRecord } from "../../../config/legacy.shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { listMutableCodexRouteAgentEntries } from "./codex-route-agent-entries.js";
import {
  canonicalOpenAIModelUsesCodexRuntime,
  isBlockedLegacyCodexModelRef,
  isOpenAICodexModelRef,
  parseCodexRouteModelRef,
  toCanonicalOpenAIModelRef,
  type LegacyCodexModelIdentity,
} from "./codex-route-model-ref.js";
import { modelConfigContainsRef, recordCodexModelHit } from "./codex-route-model-slots.js";
import type { CodexRouteHit, MutableRecord } from "./codex-route-types.js";

function agentExplicitlyReferencesCanonicalModel(agent: unknown, modelRef: string): boolean {
  const record = asMutableRecord(agent);
  if (!record) {
    return false;
  }
  for (const key of AGENT_MODEL_CONFIG_KEYS) {
    if (modelConfigContainsRef(record[key], modelRef)) {
      return true;
    }
  }
  if (modelConfigContainsRef(asMutableRecord(record.heartbeat)?.model, modelRef)) {
    return true;
  }
  if (modelConfigContainsRef(asMutableRecord(record.subagents)?.model, modelRef)) {
    return true;
  }
  const compaction = asMutableRecord(record.compaction);
  return (
    modelConfigContainsRef(compaction?.model, modelRef) ||
    modelConfigContainsRef(asMutableRecord(compaction?.memoryFlush)?.model, modelRef) ||
    asMutableRecord(record.models)?.[modelRef] !== undefined
  );
}

function resolveCurrentRuntimeIdForCanonicalModel(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const parsed = parseCodexRouteModelRef(params.modelRef);
  if (!parsed) {
    return "auto";
  }
  const configured = normalizeOptionalAgentRuntimeId(
    resolveModelRuntimePolicy({
      config: params.cfg,
      provider: parsed.provider,
      modelId: parsed.modelId,
      agentId: params.agentId,
    }).policy?.id,
  );
  if (configured) {
    return configured;
  }
  return canonicalOpenAIModelUsesCodexRuntime(params) ? "codex" : "auto";
}

function setModelRuntimePolicy(params: {
  agent: MutableRecord;
  agentPath: string;
  modelRef: string;
  runtimeId: string;
  changes: string[];
  reason: string;
}): void {
  const models = ensureRecord(params.agent, "models");
  const entry = ensureRecord(models, params.modelRef);
  const priorRuntime = asMutableRecord(entry.agentRuntime);
  if (normalizeString(priorRuntime?.id) === params.runtimeId) {
    return;
  }
  entry.agentRuntime = {
    ...priorRuntime,
    id: params.runtimeId,
  };
  params.changes.push(
    `Set ${params.agentPath}.models.${params.modelRef}.agentRuntime.id to "${params.runtimeId}" ${params.reason}.`,
  );
}

function shieldExplicitListedAgentRefsFromDefaultPolicy(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  targetRuntimeId: string;
  changes: string[];
  env?: NodeJS.ProcessEnv;
}): void {
  for (const { agent, agentId, path } of listMutableCodexRouteAgentEntries(params.cfg)) {
    if (!agentExplicitlyReferencesCanonicalModel(agent, params.modelRef)) {
      continue;
    }
    const runtimeId = resolveCurrentRuntimeIdForCanonicalModel({
      ...params,
      agentId,
    });
    if (runtimeId === params.targetRuntimeId) {
      continue;
    }
    setModelRuntimePolicy({
      ...params,
      agent,
      agentPath: path,
      runtimeId,
      reason: "so default runtime repair does not change explicit agent routing",
    });
  }
}

function legacyEntryExplicitNonDefaultRuntimeId(
  models: MutableRecord,
  canonicalModelRef: string,
): string | undefined {
  for (const ref of Object.keys(models)) {
    if (ref === canonicalModelRef || toCanonicalOpenAIModelRef(ref) !== canonicalModelRef) {
      continue;
    }
    const legacyEntry = asMutableRecord(models[ref]);
    const id = normalizeString(asMutableRecord(legacyEntry?.agentRuntime)?.id);
    if (id && id !== "auto" && id !== "default") {
      return id;
    }
  }
  return undefined;
}

export function agentIdFromAgentPath(agentPath: string): string | undefined {
  for (const prefix of ["agents.entries.", "agents.list."]) {
    if (agentPath.startsWith(prefix)) {
      return agentPath.slice(prefix.length);
    }
  }
  return undefined;
}

type PreRepairRuntimePin = {
  runtimeId: string;
  // Resolver source "model" covers agent model maps and provider catalog entries;
  // only provider-owned policy needs an eager canonical policy write.
  source: "model" | "provider" | "provider-model";
};

function modelIdMatchesProviderModelEntry(params: {
  entryId: unknown;
  provider: string;
  modelId: string;
}): boolean {
  if (typeof params.entryId !== "string") {
    return false;
  }
  const entryId = params.entryId.trim();
  if (entryId === params.modelId) {
    return true;
  }
  const slash = entryId.indexOf("/");
  if (slash <= 0) {
    return false;
  }
  return (
    normalizeProviderId(entryId.slice(0, slash)) === normalizeProviderId(params.provider) &&
    entryId.slice(slash + 1).trim() === params.modelId
  );
}

function providerModelExplicitNonDefaultRuntimeId(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
}): string | undefined {
  const providers = asMutableRecord(asMutableRecord(params.cfg.models)?.providers);
  for (const [providerId, providerConfig] of Object.entries(providers ?? {})) {
    if (normalizeProviderId(providerId) !== normalizeProviderId(params.provider)) {
      continue;
    }
    const models = asMutableRecord(providerConfig)?.models;
    if (!Array.isArray(models)) {
      continue;
    }
    for (const model of models) {
      const record = asMutableRecord(model);
      if (
        !modelIdMatchesProviderModelEntry({
          entryId: record?.id,
          provider: params.provider,
          modelId: params.modelId,
        })
      ) {
        continue;
      }
      const runtimeId = normalizeOptionalAgentRuntimeId(asMutableRecord(record?.agentRuntime)?.id);
      if (runtimeId && runtimeId !== "auto" && runtimeId !== "default" && runtimeId !== "codex") {
        return runtimeId;
      }
    }
  }
  return undefined;
}

function agentModelMapExactRuntimeId(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
  agentId?: string;
}): string | undefined {
  const agentId = normalizeAgentId(params.agentId);
  const agent = agentId
    ? listMutableCodexRouteAgentEntries(params.cfg).find((entry) => entry.agentId === agentId)
        ?.agent
    : undefined;
  const modelMaps = [
    asMutableRecord(agent?.models),
    asMutableRecord(params.cfg.agents?.defaults?.models),
  ];
  for (const models of modelMaps) {
    for (const [key, entry] of Object.entries(models ?? {})) {
      if (
        !modelIdMatchesProviderModelEntry({
          entryId: key,
          provider: params.provider,
          modelId: params.modelId,
        })
      ) {
        continue;
      }
      const runtimeId = normalizeOptionalAgentRuntimeId(
        asMutableRecord(asMutableRecord(entry)?.agentRuntime)?.id,
      );
      if (runtimeId && runtimeId !== "auto" && runtimeId !== "default") {
        return runtimeId;
      }
    }
  }
  return undefined;
}

function preRepairLegacyModelPolicyExplicitNonDefaultRuntimePin(params: {
  cfg: OpenClawConfig;
  legacyModelRef?: string;
  agentId?: string;
}): PreRepairRuntimePin | undefined {
  if (!params.legacyModelRef || !isOpenAICodexModelRef(params.legacyModelRef)) {
    return undefined;
  }
  const parsed = parseCodexRouteModelRef(params.legacyModelRef);
  if (!parsed) {
    return undefined;
  }
  const resolved = resolveModelRuntimePolicy({
    config: params.cfg,
    provider: parsed.provider,
    modelId: parsed.modelId,
    agentId: params.agentId,
  });
  const runtimeId = normalizeOptionalAgentRuntimeId(resolved.policy?.id);
  if (!runtimeId || runtimeId === "auto" || runtimeId === "default" || runtimeId === "codex") {
    return undefined;
  }
  if (resolved.source === "model") {
    const providerModelRuntimeId = providerModelExplicitNonDefaultRuntimeId({
      cfg: params.cfg,
      provider: parsed.provider,
      modelId: parsed.modelId,
    });
    const agentModelRuntimeId = agentModelMapExactRuntimeId({ ...params, ...parsed });
    if (providerModelRuntimeId === runtimeId && !agentModelRuntimeId) {
      return { runtimeId, source: "provider-model" };
    }
  }
  return { runtimeId, source: resolved.source ?? "model" };
}

export function ensureCodexRuntimePolicy(params: {
  cfg: OpenClawConfig;
  agent: MutableRecord;
  agentPath: string;
  agentId?: string;
  modelRef: string;
  legacyModelRef?: string;
  preRepairCfg?: OpenClawConfig;
  changes: string[];
  env?: NodeJS.ProcessEnv;
}): void {
  const models = asMutableRecord(params.agent.models);
  const entry = asMutableRecord(models?.[params.modelRef]);
  const priorRuntime = asMutableRecord(entry?.agentRuntime);
  const runtimeId = normalizeString(priorRuntime?.id);
  const pinnedRuntimeId =
    runtimeId && runtimeId !== "auto" && runtimeId !== "default" ? runtimeId : undefined;
  const legacyModelRuntimeId = models
    ? legacyEntryExplicitNonDefaultRuntimeId(models, params.modelRef)
    : undefined;
  const preRepairRuntimePin = preRepairLegacyModelPolicyExplicitNonDefaultRuntimePin({
    cfg: params.preRepairCfg ?? params.cfg,
    legacyModelRef: params.legacyModelRef,
    agentId: params.agentId,
  });
  const targetRuntimeId =
    pinnedRuntimeId ??
    legacyModelRuntimeId ??
    (preRepairRuntimePin?.source === "provider" || preRepairRuntimePin?.source === "provider-model"
      ? preRepairRuntimePin.runtimeId
      : undefined) ??
    "codex";
  if (params.agentPath === "agents.defaults") {
    shieldExplicitListedAgentRefsFromDefaultPolicy({
      ...params,
      targetRuntimeId,
    });
  }
  if (pinnedRuntimeId || legacyModelRuntimeId) {
    return;
  }
  if (preRepairRuntimePin?.source === "model") {
    return;
  }
  setModelRuntimePolicy({
    ...params,
    runtimeId: preRepairRuntimePin?.runtimeId ?? "codex",
    reason: preRepairRuntimePin
      ? "so legacy provider runtime pins survive Codex route repair"
      : "so repaired OpenAI refs keep Codex auth routing",
  });
}

type CanonicalCodexSlotRepair = {
  cfg: OpenClawConfig;
  agentId?: string;
  hits: CodexRouteHit[];
  container: MutableRecord | undefined;
  key: string;
  path: string;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  env?: NodeJS.ProcessEnv;
};

export function rewriteStringModelSlotIfCanonicalCodexRuntime(
  params: CanonicalCodexSlotRepair,
): void {
  if (typeof params.container?.[params.key] === "string") {
    rewriteModelConfigSlotIfCanonicalCodexRuntime(params);
  }
}

export function rewriteModelConfigSlotIfCanonicalCodexRuntime(
  params: CanonicalCodexSlotRepair,
): void {
  const rewrite = (value: string, path: string, fallback = false): string => {
    const canonicalModel = toCanonicalOpenAIModelRef(value.trim());
    if (
      !canonicalModel ||
      (fallback &&
        isBlockedLegacyCodexModelRef({
          modelRef: value,
          blockedModelIdentities: params.blockedModelIdentities,
        })) ||
      !canonicalOpenAIModelUsesCodexRuntime({ ...params, modelRef: canonicalModel })
    ) {
      return value;
    }
    return recordCodexModelHit({ ...params, path, model: value.trim() }) ?? value;
  };
  const { container, key, path } = params;
  const value = container?.[key];
  if (container && typeof value === "string") {
    container[key] = rewrite(value, path);
    return;
  }
  const record = asMutableRecord(value);
  if (!record) {
    return;
  }
  if (typeof record.primary === "string") {
    record.primary = rewrite(record.primary, `${path}.primary`);
  }
  if (Array.isArray(record.fallbacks)) {
    for (const [index, entry] of record.fallbacks.entries()) {
      if (typeof entry === "string") {
        record.fallbacks[index] = rewrite(entry, `${path}.fallbacks.${index}`, true);
      }
    }
  }
}
