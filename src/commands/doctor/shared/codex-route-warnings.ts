import fs from "node:fs";
import {
  ensureAuthProfileStore,
  resolveAuthProfileOrder,
  resolveProfileUnusableUntilForDisplay,
} from "../../../agents/auth-profiles.js";
import { evaluateStoredCredentialEligibility } from "../../../agents/auth-profiles/credential-state.js";
import { hasUsableCustomProviderApiKey, resolveEnvApiKey } from "../../../agents/model-auth.js";
import { AGENT_MODEL_CONFIG_KEYS } from "../../../config/model-refs.js";
import { loadSessionStore, updateSessionStore } from "../../../config/sessions/store.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../../../config/sessions/targets.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { AgentRuntimePolicyConfig } from "../../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  getInstalledPluginRecord,
  isInstalledPluginEnabled,
  loadInstalledPluginIndex,
} from "../../../plugins/installed-plugin-index.js";

type CodexRouteHit = {
  path: string;
  model: string;
  canonicalModel: string;
  runtime?: string;
  setsRuntime?: boolean;
};

type CodexRepairRuntime = "codex" | "pi";
type CodexRouteRepairPlan = {
  runtime: CodexRepairRuntime;
  rewriteCodexRoutes: boolean;
  recoverBrokenPiRoutes: boolean;
  hasUsableCodexOAuth: boolean;
  hasUsableOpenAIAuth: boolean;
};
type CodexSessionRouteRepairMode = "rewrite-to-openai" | "recover-codex-oauth" | "preserve";
type MutableRecord = Record<string, unknown>;
type SessionRouteRepairResult = {
  changed: boolean;
  sessionKeys: string[];
};
type CodexSessionRouteRepairSummary = {
  scannedStores: number;
  repairedStores: number;
  repairedSessions: number;
  warnings: string[];
  changes: string[];
};

const RECOVERABLE_CODEX_OAUTH_PI_MODEL_IDS = new Set([
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5.5",
  "gpt-5.5-pro",
]);

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function asMutableRecord(value: unknown): MutableRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as MutableRecord)
    : undefined;
}

function isOpenAICodexModelRef(model: string | undefined): model is string {
  return normalizeString(model)?.startsWith("openai-codex/") === true;
}

function toRecoverableCodexModelId(model: string | undefined): string | undefined {
  if (typeof model !== "string") {
    return undefined;
  }
  const trimmed = model.trim();
  if (!trimmed) {
    return undefined;
  }
  const modelId = normalizeString(trimmed)?.startsWith("openai/")
    ? trimmed.slice("openai/".length).trim()
    : trimmed;
  return RECOVERABLE_CODEX_OAUTH_PI_MODEL_IDS.has(modelId.toLowerCase()) ? modelId : undefined;
}

function isRecoverableOpenAIModelRef(model: string | undefined): model is string {
  return (
    normalizeString(model)?.startsWith("openai/") === true &&
    toRecoverableCodexModelId(model) !== undefined
  );
}

function toOpenAICodexModelRef(model: string): string | undefined {
  if (!isRecoverableOpenAIModelRef(model)) {
    return undefined;
  }
  const modelId = model.slice("openai/".length).trim();
  return modelId ? `openai-codex/${modelId}` : undefined;
}

function toCanonicalOpenAIModelRef(model: string): string | undefined {
  if (!isOpenAICodexModelRef(model)) {
    return undefined;
  }
  const modelId = model.slice("openai-codex/".length).trim();
  return modelId ? `openai/${modelId}` : undefined;
}

function toOpenAIModelId(model: string): string | undefined {
  if (!isOpenAICodexModelRef(model)) {
    return undefined;
  }
  const modelId = model.slice("openai-codex/".length).trim();
  return modelId || undefined;
}

function resolveRuntime(params: {
  env?: NodeJS.ProcessEnv;
  agentRuntime?: AgentRuntimePolicyConfig;
  defaultsRuntime?: AgentRuntimePolicyConfig;
}): string {
  return (
    normalizeString(params.env?.OPENCLAW_AGENT_RUNTIME) ??
    normalizeString(params.agentRuntime?.id) ??
    normalizeString(params.defaultsRuntime?.id) ??
    "pi"
  );
}

function recordCodexModelHit(params: {
  hits: CodexRouteHit[];
  path: string;
  model: string;
  runtime?: string;
  setsRuntime?: boolean;
}): string | undefined {
  const canonicalModel = toCanonicalOpenAIModelRef(params.model);
  if (!canonicalModel) {
    return undefined;
  }
  params.hits.push({
    path: params.path,
    model: params.model,
    canonicalModel,
    ...(params.runtime ? { runtime: params.runtime } : {}),
    ...(params.setsRuntime ? { setsRuntime: true } : {}),
  });
  return canonicalModel;
}

function collectStringModelSlot(params: {
  hits: CodexRouteHit[];
  path: string;
  value: unknown;
  runtime?: string;
  setsRuntime?: boolean;
}): boolean {
  if (typeof params.value !== "string") {
    return false;
  }
  const model = params.value.trim();
  if (!model || !isOpenAICodexModelRef(model)) {
    return false;
  }
  return !!recordCodexModelHit({
    hits: params.hits,
    path: params.path,
    model,
    runtime: params.runtime,
    setsRuntime: params.setsRuntime,
  });
}

function collectModelConfigSlot(params: {
  hits: CodexRouteHit[];
  path: string;
  value: unknown;
  runtime?: string;
  setsRuntimeOnPrimary?: boolean;
}): boolean {
  if (typeof params.value === "string") {
    return collectStringModelSlot({
      hits: params.hits,
      path: params.path,
      value: params.value,
      runtime: params.runtime,
      setsRuntime: params.setsRuntimeOnPrimary,
    });
  }
  const record = asMutableRecord(params.value);
  if (!record) {
    return false;
  }
  let rewrotePrimary = false;
  if (typeof record.primary === "string") {
    rewrotePrimary = collectStringModelSlot({
      hits: params.hits,
      path: `${params.path}.primary`,
      value: record.primary,
      runtime: params.runtime,
      setsRuntime: params.setsRuntimeOnPrimary,
    });
  }
  if (Array.isArray(record.fallbacks)) {
    for (const [index, entry] of record.fallbacks.entries()) {
      collectStringModelSlot({
        hits: params.hits,
        path: `${params.path}.fallbacks.${index}`,
        value: entry,
      });
    }
  }
  return rewrotePrimary;
}

function collectModelsMapRefs(params: {
  hits: CodexRouteHit[];
  path: string;
  models: unknown;
}): void {
  const record = asMutableRecord(params.models);
  if (!record) {
    return;
  }
  for (const modelRef of Object.keys(record)) {
    if (!isOpenAICodexModelRef(modelRef)) {
      continue;
    }
    recordCodexModelHit({
      hits: params.hits,
      path: `${params.path}.${modelRef}`,
      model: modelRef,
    });
  }
}

function collectRecoverableModelsMapRefs(params: {
  hits: CodexRouteHit[];
  path: string;
  models: unknown;
}): void {
  const record = asMutableRecord(params.models);
  if (!record) {
    return;
  }
  for (const modelRef of Object.keys(record)) {
    const codexModel = toOpenAICodexModelRef(modelRef);
    if (!codexModel) {
      continue;
    }
    params.hits.push({
      path: `${params.path}.${modelRef}`,
      model: modelRef,
      canonicalModel: codexModel,
    });
  }
}

function collectAgentModelRefs(params: {
  hits: CodexRouteHit[];
  agent: unknown;
  path: string;
  runtime?: string;
  collectModelsMap?: boolean;
}): void {
  const agent = asMutableRecord(params.agent);
  if (!agent) {
    return;
  }
  for (const key of AGENT_MODEL_CONFIG_KEYS) {
    collectModelConfigSlot({
      hits: params.hits,
      path: `${params.path}.${key}`,
      value: agent[key],
      runtime: key === "model" ? params.runtime : undefined,
      setsRuntimeOnPrimary: key === "model",
    });
  }
  collectStringModelSlot({
    hits: params.hits,
    path: `${params.path}.heartbeat.model`,
    value: asMutableRecord(agent.heartbeat)?.model,
  });
  collectModelConfigSlot({
    hits: params.hits,
    path: `${params.path}.subagents.model`,
    value: asMutableRecord(agent.subagents)?.model,
  });
  const compaction = asMutableRecord(agent.compaction);
  collectStringModelSlot({
    hits: params.hits,
    path: `${params.path}.compaction.model`,
    value: compaction?.model,
  });
  collectStringModelSlot({
    hits: params.hits,
    path: `${params.path}.compaction.memoryFlush.model`,
    value: asMutableRecord(compaction?.memoryFlush)?.model,
  });
  if (params.collectModelsMap) {
    collectModelsMapRefs({
      hits: params.hits,
      path: `${params.path}.models`,
      models: agent.models,
    });
  }
}

function collectRecoverableStringModelSlot(params: {
  hits: CodexRouteHit[];
  path: string;
  value: unknown;
  runtime?: string;
  setsRuntime?: boolean;
}): boolean {
  if (typeof params.value !== "string") {
    return false;
  }
  const model = params.value.trim();
  const codexModel = toOpenAICodexModelRef(model);
  if (!codexModel) {
    return false;
  }
  params.hits.push({
    path: params.path,
    model,
    canonicalModel: codexModel,
    ...(params.runtime ? { runtime: params.runtime } : {}),
    ...(params.setsRuntime ? { setsRuntime: true } : {}),
  });
  return true;
}

function collectRecoverableModelConfigSlot(params: {
  hits: CodexRouteHit[];
  path: string;
  value: unknown;
  runtime?: string;
  setsRuntimeOnPrimary?: boolean;
}): boolean {
  if (typeof params.value === "string") {
    return collectRecoverableStringModelSlot({
      hits: params.hits,
      path: params.path,
      value: params.value,
      runtime: params.runtime,
      setsRuntime: params.setsRuntimeOnPrimary,
    });
  }
  const record = asMutableRecord(params.value);
  if (!record) {
    return false;
  }
  let recoveredPrimary = false;
  if (typeof record.primary === "string") {
    recoveredPrimary = collectRecoverableStringModelSlot({
      hits: params.hits,
      path: `${params.path}.primary`,
      value: record.primary,
      runtime: params.runtime,
      setsRuntime: params.setsRuntimeOnPrimary,
    });
  }
  if (Array.isArray(record.fallbacks)) {
    for (const [index, entry] of record.fallbacks.entries()) {
      collectRecoverableStringModelSlot({
        hits: params.hits,
        path: `${params.path}.fallbacks.${index}`,
        value: entry,
      });
    }
  }
  return recoveredPrimary;
}

function collectRecoverableAgentModelRefs(params: {
  hits: CodexRouteHit[];
  agent: unknown;
  path: string;
  runtime?: string;
  collectModelsMap?: boolean;
}): void {
  const agent = asMutableRecord(params.agent);
  if (!agent || params.runtime !== "pi") {
    return;
  }
  for (const key of AGENT_MODEL_CONFIG_KEYS) {
    collectRecoverableModelConfigSlot({
      hits: params.hits,
      path: `${params.path}.${key}`,
      value: agent[key],
      runtime: key === "model" ? params.runtime : undefined,
      setsRuntimeOnPrimary: key === "model",
    });
  }
  collectRecoverableStringModelSlot({
    hits: params.hits,
    path: `${params.path}.heartbeat.model`,
    value: asMutableRecord(agent.heartbeat)?.model,
  });
  collectRecoverableModelConfigSlot({
    hits: params.hits,
    path: `${params.path}.subagents.model`,
    value: asMutableRecord(agent.subagents)?.model,
  });
  const compaction = asMutableRecord(agent.compaction);
  collectRecoverableStringModelSlot({
    hits: params.hits,
    path: `${params.path}.compaction.model`,
    value: compaction?.model,
  });
  collectRecoverableStringModelSlot({
    hits: params.hits,
    path: `${params.path}.compaction.memoryFlush.model`,
    value: asMutableRecord(compaction?.memoryFlush)?.model,
  });
  if (params.collectModelsMap) {
    collectRecoverableModelsMapRefs({
      hits: params.hits,
      path: `${params.path}.models`,
      models: agent.models,
    });
  }
}

function collectConfigModelRefs(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): CodexRouteHit[] {
  const hits: CodexRouteHit[] = [];
  const defaults = cfg.agents?.defaults;
  const defaultsRuntime = defaults?.agentRuntime;
  collectAgentModelRefs({
    hits,
    agent: defaults,
    path: "agents.defaults",
    runtime: resolveRuntime({ env, defaultsRuntime }),
    collectModelsMap: true,
  });

  for (const [index, agent] of (cfg.agents?.list ?? []).entries()) {
    const id = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : String(index);
    collectAgentModelRefs({
      hits,
      agent,
      path: `agents.list.${id}`,
      runtime: resolveRuntime({
        env,
        agentRuntime: agent.agentRuntime,
        defaultsRuntime,
      }),
    });
  }

  const channelsModelByChannel = asMutableRecord(cfg.channels?.modelByChannel);
  if (channelsModelByChannel) {
    for (const [channelId, channelMap] of Object.entries(channelsModelByChannel)) {
      const targets = asMutableRecord(channelMap);
      if (!targets) {
        continue;
      }
      for (const [targetId, model] of Object.entries(targets)) {
        collectStringModelSlot({
          hits,
          path: `channels.modelByChannel.${channelId}.${targetId}`,
          value: model,
        });
      }
    }
  }

  for (const [index, mapping] of (cfg.hooks?.mappings ?? []).entries()) {
    collectStringModelSlot({
      hits,
      path: `hooks.mappings.${index}.model`,
      value: mapping.model,
    });
  }
  collectStringModelSlot({
    hits,
    path: "hooks.gmail.model",
    value: cfg.hooks?.gmail?.model,
  });
  collectModelConfigSlot({
    hits,
    path: "tools.subagents.model",
    value: cfg.tools?.subagents?.model,
  });
  collectStringModelSlot({
    hits,
    path: "messages.tts.summaryModel",
    value: cfg.messages?.tts?.summaryModel,
  });
  collectStringModelSlot({
    hits,
    path: "channels.discord.voice.model",
    value: asMutableRecord(asMutableRecord(cfg.channels?.discord)?.voice)?.model,
  });
  return hits;
}

function collectRecoverableOpenAIModelRefs(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): CodexRouteHit[] {
  const hits: CodexRouteHit[] = [];
  const defaults = cfg.agents?.defaults;
  const defaultsRuntime = defaults?.agentRuntime;
  collectRecoverableAgentModelRefs({
    hits,
    agent: defaults,
    path: "agents.defaults",
    runtime: resolveRuntime({ env, defaultsRuntime }),
    collectModelsMap: true,
  });

  for (const [index, agent] of (cfg.agents?.list ?? []).entries()) {
    const id = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : String(index);
    collectRecoverableAgentModelRefs({
      hits,
      agent,
      path: `agents.list.${id}`,
      runtime: resolveRuntime({
        env,
        agentRuntime: agent.agentRuntime,
        defaultsRuntime,
      }),
    });
  }

  const channelsModelByChannel = asMutableRecord(cfg.channels?.modelByChannel);
  if (channelsModelByChannel) {
    for (const [channelId, channelMap] of Object.entries(channelsModelByChannel)) {
      const targets = asMutableRecord(channelMap);
      if (!targets) {
        continue;
      }
      for (const [targetId, model] of Object.entries(targets)) {
        collectRecoverableStringModelSlot({
          hits,
          path: `channels.modelByChannel.${channelId}.${targetId}`,
          value: model,
        });
      }
    }
  }

  for (const [index, mapping] of (cfg.hooks?.mappings ?? []).entries()) {
    collectRecoverableStringModelSlot({
      hits,
      path: `hooks.mappings.${index}.model`,
      value: mapping.model,
    });
  }
  collectRecoverableStringModelSlot({
    hits,
    path: "hooks.gmail.model",
    value: cfg.hooks?.gmail?.model,
  });
  collectRecoverableModelConfigSlot({
    hits,
    path: "tools.subagents.model",
    value: cfg.tools?.subagents?.model,
  });
  collectRecoverableStringModelSlot({
    hits,
    path: "messages.tts.summaryModel",
    value: cfg.messages?.tts?.summaryModel,
  });
  collectRecoverableStringModelSlot({
    hits,
    path: "channels.discord.voice.model",
    value: asMutableRecord(asMutableRecord(cfg.channels?.discord)?.voice)?.model,
  });
  return hits;
}

function rewriteStringModelSlot(params: {
  hits: CodexRouteHit[];
  container: MutableRecord | undefined;
  key: string;
  path: string;
  runtime?: string;
  setsRuntime?: boolean;
}): boolean {
  if (!params.container) {
    return false;
  }
  const value = params.container[params.key];
  const model = typeof value === "string" ? value.trim() : "";
  if (!model || !isOpenAICodexModelRef(model)) {
    return false;
  }
  const canonicalModel = recordCodexModelHit({
    hits: params.hits,
    path: params.path,
    model,
    runtime: params.runtime,
    setsRuntime: params.setsRuntime,
  });
  if (!canonicalModel) {
    return false;
  }
  params.container[params.key] = canonicalModel;
  return true;
}

function rewriteStringModelSlotToCodex(params: {
  hits: CodexRouteHit[];
  container: MutableRecord | undefined;
  key: string;
  path: string;
  runtime?: string;
  clearsRuntime?: boolean;
}): boolean {
  if (!params.container) {
    return false;
  }
  const value = params.container[params.key];
  const model = typeof value === "string" ? value.trim() : "";
  const codexModel = toOpenAICodexModelRef(model);
  if (!codexModel) {
    return false;
  }
  params.hits.push({
    path: params.path,
    model,
    canonicalModel: codexModel,
    ...(params.runtime ? { runtime: params.runtime } : {}),
    ...(params.clearsRuntime ? { setsRuntime: true } : {}),
  });
  params.container[params.key] = codexModel;
  return true;
}

function rewriteModelConfigSlot(params: {
  hits: CodexRouteHit[];
  container: MutableRecord | undefined;
  key: string;
  path: string;
  runtime?: string;
  setsRuntimeOnPrimary?: boolean;
}): boolean {
  if (!params.container) {
    return false;
  }
  const value = params.container[params.key];
  if (typeof value === "string") {
    return rewriteStringModelSlot({
      hits: params.hits,
      container: params.container,
      key: params.key,
      path: params.path,
      runtime: params.runtime,
      setsRuntime: params.setsRuntimeOnPrimary,
    });
  }
  const record = asMutableRecord(value);
  if (!record) {
    return false;
  }
  const rewrotePrimary = rewriteStringModelSlot({
    hits: params.hits,
    container: record,
    key: "primary",
    path: `${params.path}.primary`,
    runtime: params.runtime,
    setsRuntime: params.setsRuntimeOnPrimary,
  });
  if (Array.isArray(record.fallbacks)) {
    record.fallbacks = record.fallbacks.map((entry, index) => {
      if (typeof entry !== "string") {
        return entry;
      }
      const model = entry.trim();
      const canonicalModel = recordCodexModelHit({
        hits: params.hits,
        path: `${params.path}.fallbacks.${index}`,
        model,
      });
      return canonicalModel ?? entry;
    });
  }
  return rewrotePrimary;
}

function rewriteModelConfigSlotToCodex(params: {
  hits: CodexRouteHit[];
  container: MutableRecord | undefined;
  key: string;
  path: string;
  runtime?: string;
  clearsRuntimeOnPrimary?: boolean;
}): boolean {
  if (!params.container) {
    return false;
  }
  const value = params.container[params.key];
  if (typeof value === "string") {
    return rewriteStringModelSlotToCodex({
      hits: params.hits,
      container: params.container,
      key: params.key,
      path: params.path,
      runtime: params.runtime,
      clearsRuntime: params.clearsRuntimeOnPrimary,
    });
  }
  const record = asMutableRecord(value);
  if (!record) {
    return false;
  }
  const recoveredPrimary = rewriteStringModelSlotToCodex({
    hits: params.hits,
    container: record,
    key: "primary",
    path: `${params.path}.primary`,
    runtime: params.runtime,
    clearsRuntime: params.clearsRuntimeOnPrimary,
  });
  if (Array.isArray(record.fallbacks)) {
    record.fallbacks = record.fallbacks.map((entry, index) => {
      if (typeof entry !== "string") {
        return entry;
      }
      const model = entry.trim();
      const codexModel = toOpenAICodexModelRef(model);
      if (!codexModel) {
        return entry;
      }
      params.hits.push({
        path: `${params.path}.fallbacks.${index}`,
        model,
        canonicalModel: codexModel,
      });
      return codexModel;
    });
  }
  return recoveredPrimary;
}

function rewriteModelsMap(params: {
  hits: CodexRouteHit[];
  models: MutableRecord | undefined;
  path: string;
}): void {
  if (!params.models) {
    return;
  }
  for (const legacyRef of Object.keys(params.models)) {
    const canonicalModel = toCanonicalOpenAIModelRef(legacyRef);
    if (!canonicalModel) {
      continue;
    }
    recordCodexModelHit({
      hits: params.hits,
      path: `${params.path}.${legacyRef}`,
      model: legacyRef,
    });
    params.models[canonicalModel] ??= params.models[legacyRef] ?? {};
    delete params.models[legacyRef];
  }
}

function rewriteModelsMapToCodex(params: {
  hits: CodexRouteHit[];
  models: MutableRecord | undefined;
  path: string;
}): void {
  if (!params.models) {
    return;
  }
  for (const openAIRef of Object.keys(params.models)) {
    const codexModel = toOpenAICodexModelRef(openAIRef);
    if (!codexModel) {
      continue;
    }
    params.hits.push({
      path: `${params.path}.${openAIRef}`,
      model: openAIRef,
      canonicalModel: codexModel,
    });
    params.models[codexModel] ??= params.models[openAIRef] ?? {};
    delete params.models[openAIRef];
  }
}

function clearPiRuntimeOverride(agent: MutableRecord): void {
  const agentRuntime = asMutableRecord(agent.agentRuntime);
  if (!agentRuntime || normalizeString(agentRuntime.id) !== "pi") {
    return;
  }
  delete agentRuntime.id;
  if (Object.keys(agentRuntime).length === 0) {
    delete agent.agentRuntime;
  }
}

function rewriteAgentModelRefs(params: {
  hits: CodexRouteHit[];
  agent: MutableRecord | undefined;
  path: string;
  runtime: CodexRepairRuntime;
  currentRuntime: string;
  rewriteModelsMap?: boolean;
}): void {
  if (!params.agent) {
    return;
  }
  for (const key of AGENT_MODEL_CONFIG_KEYS) {
    const rewrotePrimary = rewriteModelConfigSlot({
      hits: params.hits,
      container: params.agent,
      key,
      path: `${params.path}.${key}`,
      runtime: key === "model" ? params.currentRuntime : undefined,
      setsRuntimeOnPrimary: key === "model",
    });
    if (key === "model" && rewrotePrimary) {
      const agentRuntime = asMutableRecord(params.agent.agentRuntime) ?? {};
      agentRuntime.id = params.runtime;
      params.agent.agentRuntime = agentRuntime;
    }
  }
  rewriteStringModelSlot({
    hits: params.hits,
    container: asMutableRecord(params.agent.heartbeat),
    key: "model",
    path: `${params.path}.heartbeat.model`,
  });
  rewriteModelConfigSlot({
    hits: params.hits,
    container: asMutableRecord(params.agent.subagents),
    key: "model",
    path: `${params.path}.subagents.model`,
  });
  const compaction = asMutableRecord(params.agent.compaction);
  rewriteStringModelSlot({
    hits: params.hits,
    container: compaction,
    key: "model",
    path: `${params.path}.compaction.model`,
  });
  rewriteStringModelSlot({
    hits: params.hits,
    container: asMutableRecord(compaction?.memoryFlush),
    key: "model",
    path: `${params.path}.compaction.memoryFlush.model`,
  });
  if (params.rewriteModelsMap) {
    rewriteModelsMap({
      hits: params.hits,
      models: asMutableRecord(params.agent.models),
      path: `${params.path}.models`,
    });
  }
}

function rewriteAgentModelRefsToCodex(params: {
  hits: CodexRouteHit[];
  agent: MutableRecord | undefined;
  path: string;
  currentRuntime: string;
  rewriteModelsMap?: boolean;
}): void {
  if (!params.agent || params.currentRuntime !== "pi") {
    return;
  }
  for (const key of AGENT_MODEL_CONFIG_KEYS) {
    const recoveredPrimary = rewriteModelConfigSlotToCodex({
      hits: params.hits,
      container: params.agent,
      key,
      path: `${params.path}.${key}`,
      runtime: key === "model" ? params.currentRuntime : undefined,
      clearsRuntimeOnPrimary: key === "model",
    });
    if (key === "model" && recoveredPrimary) {
      clearPiRuntimeOverride(params.agent);
    }
  }
  rewriteStringModelSlotToCodex({
    hits: params.hits,
    container: asMutableRecord(params.agent.heartbeat),
    key: "model",
    path: `${params.path}.heartbeat.model`,
  });
  rewriteModelConfigSlotToCodex({
    hits: params.hits,
    container: asMutableRecord(params.agent.subagents),
    key: "model",
    path: `${params.path}.subagents.model`,
  });
  const compaction = asMutableRecord(params.agent.compaction);
  rewriteStringModelSlotToCodex({
    hits: params.hits,
    container: compaction,
    key: "model",
    path: `${params.path}.compaction.model`,
  });
  rewriteStringModelSlotToCodex({
    hits: params.hits,
    container: asMutableRecord(compaction?.memoryFlush),
    key: "model",
    path: `${params.path}.compaction.memoryFlush.model`,
  });
  if (params.rewriteModelsMap) {
    rewriteModelsMapToCodex({
      hits: params.hits,
      models: asMutableRecord(params.agent.models),
      path: `${params.path}.models`,
    });
  }
}

function rewriteConfigModelRefs(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runtime: CodexRepairRuntime;
}): { cfg: OpenClawConfig; changes: CodexRouteHit[] } {
  const nextConfig = structuredClone(params.cfg);
  const hits: CodexRouteHit[] = [];
  const defaultsRuntime = nextConfig.agents?.defaults?.agentRuntime;
  rewriteAgentModelRefs({
    hits,
    agent: asMutableRecord(nextConfig.agents?.defaults),
    path: "agents.defaults",
    runtime: params.runtime,
    currentRuntime: resolveRuntime({ env: params.env, defaultsRuntime }),
    rewriteModelsMap: true,
  });
  for (const [index, agent] of (nextConfig.agents?.list ?? []).entries()) {
    const id = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : String(index);
    rewriteAgentModelRefs({
      hits,
      agent: agent as MutableRecord,
      path: `agents.list.${id}`,
      runtime: params.runtime,
      currentRuntime: resolveRuntime({
        env: params.env,
        agentRuntime: agent.agentRuntime,
        defaultsRuntime,
      }),
    });
  }
  const channelsModelByChannel = asMutableRecord(nextConfig.channels?.modelByChannel);
  if (channelsModelByChannel) {
    for (const [channelId, channelMap] of Object.entries(channelsModelByChannel)) {
      const targets = asMutableRecord(channelMap);
      if (!targets) {
        continue;
      }
      for (const targetId of Object.keys(targets)) {
        rewriteStringModelSlot({
          hits,
          container: targets,
          key: targetId,
          path: `channels.modelByChannel.${channelId}.${targetId}`,
        });
      }
    }
  }
  for (const [index, mapping] of (nextConfig.hooks?.mappings ?? []).entries()) {
    rewriteStringModelSlot({
      hits,
      container: mapping as MutableRecord,
      key: "model",
      path: `hooks.mappings.${index}.model`,
    });
  }
  rewriteStringModelSlot({
    hits,
    container: asMutableRecord(nextConfig.hooks?.gmail),
    key: "model",
    path: "hooks.gmail.model",
  });
  rewriteModelConfigSlot({
    hits,
    container: asMutableRecord(nextConfig.tools?.subagents),
    key: "model",
    path: "tools.subagents.model",
  });
  rewriteStringModelSlot({
    hits,
    container: asMutableRecord(nextConfig.messages?.tts),
    key: "summaryModel",
    path: "messages.tts.summaryModel",
  });
  rewriteStringModelSlot({
    hits,
    container: asMutableRecord(asMutableRecord(nextConfig.channels?.discord)?.voice),
    key: "model",
    path: "channels.discord.voice.model",
  });
  return {
    cfg: hits.length > 0 ? nextConfig : params.cfg,
    changes: hits,
  };
}

function rewriteConfigModelRefsToCodex(params: { cfg: OpenClawConfig; env?: NodeJS.ProcessEnv }): {
  cfg: OpenClawConfig;
  changes: CodexRouteHit[];
} {
  const nextConfig = structuredClone(params.cfg);
  const hits: CodexRouteHit[] = [];
  const defaultsRuntime = nextConfig.agents?.defaults?.agentRuntime;
  rewriteAgentModelRefsToCodex({
    hits,
    agent: asMutableRecord(nextConfig.agents?.defaults),
    path: "agents.defaults",
    currentRuntime: resolveRuntime({ env: params.env, defaultsRuntime }),
    rewriteModelsMap: true,
  });
  for (const [index, agent] of (nextConfig.agents?.list ?? []).entries()) {
    const id = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : String(index);
    rewriteAgentModelRefsToCodex({
      hits,
      agent: agent as MutableRecord,
      path: `agents.list.${id}`,
      currentRuntime: resolveRuntime({
        env: params.env,
        agentRuntime: agent.agentRuntime,
        defaultsRuntime,
      }),
    });
  }
  const channelsModelByChannel = asMutableRecord(nextConfig.channels?.modelByChannel);
  if (channelsModelByChannel) {
    for (const [channelId, channelMap] of Object.entries(channelsModelByChannel)) {
      const targets = asMutableRecord(channelMap);
      if (!targets) {
        continue;
      }
      for (const targetId of Object.keys(targets)) {
        rewriteStringModelSlotToCodex({
          hits,
          container: targets,
          key: targetId,
          path: `channels.modelByChannel.${channelId}.${targetId}`,
        });
      }
    }
  }
  for (const [index, mapping] of (nextConfig.hooks?.mappings ?? []).entries()) {
    rewriteStringModelSlotToCodex({
      hits,
      container: mapping as MutableRecord,
      key: "model",
      path: `hooks.mappings.${index}.model`,
    });
  }
  rewriteStringModelSlotToCodex({
    hits,
    container: asMutableRecord(nextConfig.hooks?.gmail),
    key: "model",
    path: "hooks.gmail.model",
  });
  rewriteModelConfigSlotToCodex({
    hits,
    container: asMutableRecord(nextConfig.tools?.subagents),
    key: "model",
    path: "tools.subagents.model",
  });
  rewriteStringModelSlotToCodex({
    hits,
    container: asMutableRecord(nextConfig.messages?.tts),
    key: "summaryModel",
    path: "messages.tts.summaryModel",
  });
  rewriteStringModelSlotToCodex({
    hits,
    container: asMutableRecord(asMutableRecord(nextConfig.channels?.discord)?.voice),
    key: "model",
    path: "channels.discord.voice.model",
  });
  return {
    cfg: hits.length > 0 ? nextConfig : params.cfg,
    changes: hits,
  };
}

function hasUsableProviderProfile(cfg: OpenClawConfig, provider: string): boolean {
  try {
    const store = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false, config: cfg });
    const now = Date.now();
    return resolveAuthProfileOrder({ cfg, store, provider }).some((profileId) => {
      const credential = store.profiles[profileId];
      if (!credential) {
        return false;
      }
      const unusableUntil = resolveProfileUnusableUntilForDisplay(store, profileId);
      if (unusableUntil && now < unusableUntil) {
        return false;
      }
      return evaluateStoredCredentialEligibility({ credential, now }).eligible;
    });
  } catch {
    return false;
  }
}

function hasUsableCodexOAuthProfile(cfg: OpenClawConfig): boolean {
  try {
    const store = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false, config: cfg });
    const now = Date.now();
    return resolveAuthProfileOrder({ cfg, store, provider: "openai-codex" }).some((profileId) => {
      const credential = store.profiles[profileId];
      if (!credential || credential.type !== "oauth") {
        return false;
      }
      const unusableUntil = resolveProfileUnusableUntilForDisplay(store, profileId);
      if (unusableUntil && now < unusableUntil) {
        return false;
      }
      return evaluateStoredCredentialEligibility({ credential, now }).eligible;
    });
  } catch {
    return false;
  }
}

function hasUsableOpenAIAuth(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): boolean {
  if (hasUsableProviderProfile(cfg, "openai")) {
    return true;
  }
  if (resolveEnvApiKey("openai", env ?? process.env, { config: cfg })) {
    return true;
  }
  return hasUsableCustomProviderApiKey(cfg, "openai", env);
}

function isCodexPluginInstalledAndEnabled(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): boolean {
  const index = loadInstalledPluginIndex({ config: cfg, env });
  const record = getInstalledPluginRecord(index, "codex");
  if (!record || !record.startup.agentHarnesses.includes("codex")) {
    return false;
  }
  return isInstalledPluginEnabled(index, "codex", cfg);
}

function resolveCodexRepairRuntime(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  codexRuntimeReady?: boolean;
}): CodexRepairRuntime {
  if (params.codexRuntimeReady !== undefined) {
    return params.codexRuntimeReady ? "codex" : "pi";
  }
  return isCodexPluginInstalledAndEnabled(params.cfg, params.env) &&
    hasUsableCodexOAuthProfile(params.cfg)
    ? "codex"
    : "pi";
}

function resolveCodexRouteRepairPlan(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  codexRuntimeReady?: boolean;
}): CodexRouteRepairPlan {
  const runtime = resolveCodexRepairRuntime(params);
  const hasUsableCodexOAuth = hasUsableCodexOAuthProfile(params.cfg);
  const openAIAuthAvailable = hasUsableOpenAIAuth(params.cfg, params.env);
  const rewriteCodexRoutes = runtime === "codex" || (!hasUsableCodexOAuth && openAIAuthAvailable);
  return {
    runtime,
    rewriteCodexRoutes,
    recoverBrokenPiRoutes: runtime === "pi" && hasUsableCodexOAuth && !openAIAuthAvailable,
    hasUsableCodexOAuth,
    hasUsableOpenAIAuth: openAIAuthAvailable,
  };
}

function resolveSessionRouteRepairMode(plan: CodexRouteRepairPlan): CodexSessionRouteRepairMode {
  if (plan.rewriteCodexRoutes) {
    return "rewrite-to-openai";
  }
  return plan.recoverBrokenPiRoutes ? "recover-codex-oauth" : "preserve";
}

function formatCodexRouteChange(hit: CodexRouteHit, runtime: CodexRepairRuntime): string {
  const suffix = hit.setsRuntime ? `; set agentRuntime.id to "${runtime}"` : "";
  return `${hit.path}: ${hit.model} -> ${hit.canonicalModel}${suffix}.`;
}

function formatCodexRouteRecovery(hit: CodexRouteHit): string {
  return `${hit.path}: ${hit.model} -> ${hit.canonicalModel}.`;
}

export function collectCodexRouteWarnings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const hits = collectConfigModelRefs(params.cfg, params.env);
  const plan = resolveCodexRouteRepairPlan({
    cfg: params.cfg,
    env: params.env,
  });
  const recoverableHits = plan.recoverBrokenPiRoutes
    ? collectRecoverableOpenAIModelRefs(params.cfg, params.env)
    : [];
  if (hits.length === 0 && recoverableHits.length === 0) {
    return [];
  }
  const warnings: string[] = [];
  if (hits.length > 0) {
    const repairHint = plan.rewriteCodexRoutes
      ? 'Run `openclaw doctor --fix`: it rewrites configured model refs and stale sessions; primary routes select `agentRuntime.id: "codex"` only when the Codex runtime is installed, enabled, and has usable OAuth.'
      : plan.hasUsableCodexOAuth
        ? "`openclaw doctor --fix` preserves these routes because they are the working Codex OAuth route through OpenClaw PI."
        : "`openclaw doctor --fix` leaves these routes unchanged until direct OpenAI auth or the native Codex runtime is available.";
    warnings.push(
      [
        "- `openai-codex/*` model refs use the Codex OAuth route through OpenClaw PI.",
        ...hits.map(
          (hit) =>
            `- ${hit.path}: ${hit.model}${
              plan.rewriteCodexRoutes ? ` can become ${hit.canonicalModel}` : " is preserved"
            }${hit.runtime ? `; current runtime is "${hit.runtime}"` : ""}.`,
        ),
        `- ${repairHint}`,
      ].join("\n"),
    );
  }
  if (recoverableHits.length > 0) {
    warnings.push(
      [
        "- Direct `openai/*` GPT-5 model refs are configured for PI, but only Codex OAuth auth is available.",
        ...recoverableHits.map(
          (hit) =>
            `- ${hit.path}: ${hit.model} can be recovered to ${hit.canonicalModel}${
              hit.runtime ? `; current runtime is "${hit.runtime}"` : ""
            }.`,
        ),
        "- Run `openclaw doctor --fix` to recover the Codex OAuth PI route instead of leaving the agent on a direct OpenAI API route without OpenAI API auth.",
      ].join("\n"),
    );
  }
  return warnings;
}

export function maybeRepairCodexRoutes(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  codexRuntimeReady?: boolean;
}): { cfg: OpenClawConfig; warnings: string[]; changes: string[] } {
  const hits = collectConfigModelRefs(params.cfg, params.env);
  const plan = resolveCodexRouteRepairPlan({
    cfg: params.cfg,
    env: params.env,
    codexRuntimeReady: params.codexRuntimeReady,
  });
  const recoverableHits = plan.recoverBrokenPiRoutes
    ? collectRecoverableOpenAIModelRefs(params.cfg, params.env)
    : [];
  if (hits.length === 0 && recoverableHits.length === 0) {
    return { cfg: params.cfg, warnings: [], changes: [] };
  }
  if (!params.shouldRepair) {
    return {
      cfg: params.cfg,
      warnings: collectCodexRouteWarnings({ cfg: params.cfg, env: params.env }),
      changes: [],
    };
  }
  let cfg = params.cfg;
  const warnings: string[] = [];
  const changes: string[] = [];
  if (hits.length > 0 && plan.rewriteCodexRoutes) {
    const repaired = rewriteConfigModelRefs({
      cfg,
      env: params.env,
      runtime: plan.runtime,
    });
    cfg = repaired.cfg;
    if (repaired.changes.length > 0) {
      changes.push(
        `Repaired Codex model routes:\n${repaired.changes
          .map((hit) => `- ${formatCodexRouteChange(hit, plan.runtime)}`)
          .join("\n")}`,
      );
    }
  } else if (hits.length > 0) {
    warnings.push(
      plan.hasUsableCodexOAuth
        ? "Preserved Codex OAuth model routes; direct `openai/*` repair would move a working subscription route to a different auth/billing path."
        : "Skipped Codex model route repair because neither direct OpenAI auth nor the native Codex runtime is available.",
    );
  }
  if (recoverableHits.length > 0) {
    const recovered = rewriteConfigModelRefsToCodex({
      cfg,
      env: params.env,
    });
    cfg = recovered.cfg;
    if (recovered.changes.length > 0) {
      changes.push(
        `Recovered Codex OAuth model routes:\n${recovered.changes
          .map((hit) => `- ${formatCodexRouteRecovery(hit)}`)
          .join("\n")}`,
      );
    }
  }
  return {
    cfg,
    warnings,
    changes,
  };
}

function rewriteSessionModelPair(params: {
  entry: SessionEntry;
  providerKey: "modelProvider" | "providerOverride";
  modelKey: "model" | "modelOverride";
}): boolean {
  let changed = false;
  const provider = normalizeString(params.entry[params.providerKey]);
  const model =
    typeof params.entry[params.modelKey] === "string" ? params.entry[params.modelKey] : undefined;
  if (provider === "openai-codex") {
    params.entry[params.providerKey] = "openai";
    changed = true;
    if (model) {
      const modelId = toOpenAIModelId(model);
      if (modelId) {
        params.entry[params.modelKey] = modelId;
      }
    }
    return true;
  }
  if (model && isOpenAICodexModelRef(model)) {
    const canonicalModel = toCanonicalOpenAIModelRef(model);
    if (canonicalModel) {
      params.entry[params.modelKey] = canonicalModel;
      changed = true;
    }
  }
  return changed;
}

function recoverSessionModelPairToCodex(params: {
  entry: SessionEntry;
  providerKey: "modelProvider" | "providerOverride";
  modelKey: "model" | "modelOverride";
}): boolean {
  let changed = false;
  const provider = normalizeString(params.entry[params.providerKey]);
  const model =
    typeof params.entry[params.modelKey] === "string" ? params.entry[params.modelKey] : undefined;
  if (provider === "openai") {
    const modelId = toRecoverableCodexModelId(model);
    if (!modelId) {
      return false;
    }
    params.entry[params.providerKey] = "openai-codex";
    params.entry[params.modelKey] = modelId;
    return true;
  }
  if (!provider && model && isRecoverableOpenAIModelRef(model)) {
    const codexModel = toOpenAICodexModelRef(model);
    if (codexModel) {
      params.entry[params.modelKey] = codexModel;
      changed = true;
    }
  }
  return changed;
}

function clearStaleCodexFallbackNotice(entry: SessionEntry): boolean {
  if (
    !isOpenAICodexModelRef(entry.fallbackNoticeSelectedModel) &&
    !isOpenAICodexModelRef(entry.fallbackNoticeActiveModel)
  ) {
    return false;
  }
  delete entry.fallbackNoticeSelectedModel;
  delete entry.fallbackNoticeActiveModel;
  delete entry.fallbackNoticeReason;
  return true;
}

function clearStaleCodexAuthOverride(entry: SessionEntry, runtime: CodexRepairRuntime): boolean {
  if (runtime === "codex" || !entry.authProfileOverride?.startsWith("openai-codex:")) {
    return false;
  }
  delete entry.authProfileOverride;
  delete entry.authProfileOverrideSource;
  delete entry.authProfileOverrideCompactionCount;
  return true;
}

export function repairCodexSessionStoreRoutes(params: {
  store: Record<string, SessionEntry>;
  runtime: CodexRepairRuntime;
  mode: CodexSessionRouteRepairMode;
  now?: number;
}): SessionRouteRepairResult {
  const now = params.now ?? Date.now();
  const sessionKeys: string[] = [];
  for (const [sessionKey, entry] of Object.entries(params.store)) {
    if (!entry) {
      continue;
    }
    const changedRuntimeModelRoute =
      params.mode === "rewrite-to-openai"
        ? rewriteSessionModelPair({
            entry,
            providerKey: "modelProvider",
            modelKey: "model",
          })
        : params.mode === "recover-codex-oauth"
          ? recoverSessionModelPairToCodex({
              entry,
              providerKey: "modelProvider",
              modelKey: "model",
            })
          : false;
    const changedOverrideModelRoute =
      params.mode === "rewrite-to-openai"
        ? rewriteSessionModelPair({
            entry,
            providerKey: "providerOverride",
            modelKey: "modelOverride",
          })
        : params.mode === "recover-codex-oauth"
          ? recoverSessionModelPairToCodex({
              entry,
              providerKey: "providerOverride",
              modelKey: "modelOverride",
            })
          : false;
    const changedModelRoute = changedRuntimeModelRoute || changedOverrideModelRoute;
    const changedFallbackNotice =
      params.mode === "rewrite-to-openai" ? clearStaleCodexFallbackNotice(entry) : false;
    const changedAuthOverride =
      params.mode === "rewrite-to-openai"
        ? clearStaleCodexAuthOverride(entry, params.runtime)
        : false;
    const shouldRepinCodexHarness =
      params.mode === "rewrite-to-openai" &&
      entry.agentHarnessId === "codex" &&
      params.runtime !== "codex";
    if (
      !changedModelRoute &&
      !changedFallbackNotice &&
      !changedAuthOverride &&
      !shouldRepinCodexHarness
    ) {
      continue;
    }
    if (params.mode === "rewrite-to-openai" && (changedModelRoute || shouldRepinCodexHarness)) {
      entry.agentHarnessId = params.runtime;
      entry.agentRuntimeOverride = params.runtime;
    }
    entry.updatedAt = now;
    sessionKeys.push(sessionKey);
  }
  return {
    changed: sessionKeys.length > 0,
    sessionKeys,
  };
}

function hasRecoverableOpenAISessionRoute(entry: SessionEntry): boolean {
  const hasRecoverableRuntimeRoute =
    normalizeString(entry.modelProvider) === "openai" &&
    toRecoverableCodexModelId(entry.model) !== undefined;
  const hasRecoverableOverrideRoute =
    normalizeString(entry.providerOverride) === "openai" &&
    toRecoverableCodexModelId(entry.modelOverride) !== undefined;
  return (
    hasRecoverableRuntimeRoute ||
    hasRecoverableOverrideRoute ||
    isRecoverableOpenAIModelRef(entry.model) ||
    isRecoverableOpenAIModelRef(entry.modelOverride)
  );
}

function scanCodexSessionStoreRoutes(
  store: Record<string, SessionEntry>,
  runtime: CodexRepairRuntime,
  mode: CodexSessionRouteRepairMode,
): string[] {
  return Object.entries(store).flatMap(([sessionKey, entry]) => {
    if (!entry) {
      return [];
    }
    const hasLegacyRoute =
      mode === "rewrite-to-openai" &&
      (normalizeString(entry.modelProvider) === "openai-codex" ||
        normalizeString(entry.providerOverride) === "openai-codex" ||
        isOpenAICodexModelRef(entry.model) ||
        isOpenAICodexModelRef(entry.modelOverride) ||
        isOpenAICodexModelRef(entry.fallbackNoticeSelectedModel) ||
        isOpenAICodexModelRef(entry.fallbackNoticeActiveModel) ||
        (runtime !== "codex" && entry.authProfileOverride?.startsWith("openai-codex:") === true) ||
        (runtime !== "codex" && entry.agentHarnessId === "codex"));
    const hasBrokenPiRoute =
      mode === "recover-codex-oauth" && hasRecoverableOpenAISessionRoute(entry);
    return hasLegacyRoute || hasBrokenPiRoute ? [sessionKey] : [];
  });
}

export async function maybeRepairCodexSessionRoutes(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  codexRuntimeReady?: boolean;
}): Promise<CodexSessionRouteRepairSummary> {
  const targets = resolveAllAgentSessionStoreTargetsSync(params.cfg, {
    env: params.env ?? process.env,
  }).filter((target) => fs.existsSync(target.storePath));
  if (targets.length === 0) {
    return {
      scannedStores: 0,
      repairedStores: 0,
      repairedSessions: 0,
      warnings: [],
      changes: [],
    };
  }
  if (!params.shouldRepair) {
    const plan = resolveCodexRouteRepairPlan({
      cfg: params.cfg,
      env: params.env,
      codexRuntimeReady: params.codexRuntimeReady,
    });
    const mode = resolveSessionRouteRepairMode(plan);
    const stale = targets.flatMap((target) => {
      const sessionKeys = scanCodexSessionStoreRoutes(
        loadSessionStore(target.storePath),
        plan.runtime,
        mode,
      );
      return sessionKeys.map((sessionKey) => `${target.agentId}:${sessionKey}`);
    });
    return {
      scannedStores: targets.length,
      repairedStores: 0,
      repairedSessions: 0,
      warnings:
        stale.length > 0
          ? [
              [
                mode === "recover-codex-oauth"
                  ? "- Direct `openai/*` session route state detected without direct OpenAI auth."
                  : "- Legacy `openai-codex/*` session route state detected.",
                `- Affected sessions: ${stale.length}.`,
                mode === "recover-codex-oauth"
                  ? "- Run `openclaw doctor --fix` to recover stale session model/provider pins to the Codex OAuth PI route."
                  : "- Run `openclaw doctor --fix` to rewrite stale session model/provider pins across all agent session stores.",
              ].join("\n"),
            ]
          : [],
      changes: [],
    };
  }
  const plan = resolveCodexRouteRepairPlan({
    cfg: params.cfg,
    env: params.env,
    codexRuntimeReady: params.codexRuntimeReady,
  });
  const mode = resolveSessionRouteRepairMode(plan);
  let repairedStores = 0;
  let repairedSessions = 0;
  for (const target of targets) {
    const staleSessionKeys = scanCodexSessionStoreRoutes(
      loadSessionStore(target.storePath),
      plan.runtime,
      mode,
    );
    if (staleSessionKeys.length === 0) {
      continue;
    }
    const result = await updateSessionStore(
      target.storePath,
      (store) => repairCodexSessionStoreRoutes({ store, runtime: plan.runtime, mode }),
      { skipMaintenance: true },
    );
    if (!result.changed) {
      continue;
    }
    repairedStores += 1;
    repairedSessions += result.sessionKeys.length;
  }
  return {
    scannedStores: targets.length,
    repairedStores,
    repairedSessions,
    warnings: [],
    changes:
      repairedSessions > 0
        ? [
            `${mode === "recover-codex-oauth" ? "Recovered" : "Repaired"} Codex session routes: moved ${repairedSessions} session${
              repairedSessions === 1 ? "" : "s"
            } across ${repairedStores} store${repairedStores === 1 ? "" : "s"} ${
              mode === "recover-codex-oauth"
                ? "back to openai-codex/* with OpenClaw PI."
                : `to openai/* with agentRuntime "${plan.runtime}".`
            }`,
          ]
        : [],
  };
}
