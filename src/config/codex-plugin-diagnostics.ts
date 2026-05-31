import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  OPENCLAW_AGENT_RUNTIME_ID,
  normalizeOptionalAgentRuntimeId,
} from "../agents/agent-runtime-id.js";
import type { AgentModelEntryConfig } from "./types.agent-defaults.js";
import type { AgentRuntimePolicyConfig } from "./types.agents-shared.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const CODEX_PLUGIN_ID = "codex";
const OPENAI_PROVIDER_ID = "openai";

function normalizeRuntimeId(raw?: string | null): string | undefined {
  return normalizeOptionalAgentRuntimeId(raw);
}

function isOpenClawRuntimeSelection(raw?: string | null): boolean {
  return normalizeRuntimeId(raw) === OPENCLAW_AGENT_RUNTIME_ID;
}

function isCodexRuntimeSelection(raw?: string | null): boolean {
  return normalizeRuntimeId(raw) === CODEX_PLUGIN_ID;
}

function parseProviderModelRef(raw: string): { provider: string; model: string } | null {
  const slashIndex = raw.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= raw.length - 1) {
    return null;
  }
  const provider = normalizeProviderId(raw.slice(0, slashIndex));
  const model = raw.slice(slashIndex + 1).trim();
  return provider && model ? { provider, model } : null;
}

function codexPluginEntryEnabled(cfg: OpenClawConfig): boolean | undefined {
  for (const [pluginId, entry] of Object.entries(cfg.plugins?.entries ?? {})) {
    if (normalizeLowercaseStringOrEmpty(pluginId) === CODEX_PLUGIN_ID) {
      return entry?.enabled;
    }
  }
  return undefined;
}

function openAiProviderRuntimePolicy(cfg: OpenClawConfig): AgentRuntimePolicyConfig | undefined {
  for (const [providerId, providerConfig] of Object.entries(cfg.models?.providers ?? {})) {
    if (normalizeProviderId(providerId) === OPENAI_PROVIDER_ID) {
      return providerConfig?.agentRuntime?.id?.trim() ? providerConfig.agentRuntime : undefined;
    }
  }
  return undefined;
}

function openAiHasCodexRuntimePolicy(cfg: OpenClawConfig): boolean {
  for (const [providerId, providerConfig] of Object.entries(cfg.models?.providers ?? {})) {
    if (normalizeProviderId(providerId) !== OPENAI_PROVIDER_ID) {
      continue;
    }
    if (isCodexRuntimeSelection(providerConfig?.agentRuntime?.id)) {
      return true;
    }
    if (providerConfig?.models?.some((model) => isCodexRuntimeSelection(model.agentRuntime?.id))) {
      return true;
    }
  }
  if (agentModelsHaveCodexRuntimePolicy(cfg.agents?.defaults?.models)) {
    return true;
  }
  return (
    cfg.agents?.list?.some((agent) => agentModelsHaveCodexRuntimePolicy(agent.models)) ?? false
  );
}

function agentModelsHaveCodexRuntimePolicy(
  models: Record<string, AgentModelEntryConfig> | undefined,
): boolean {
  for (const [modelRef, modelConfig] of Object.entries(models ?? {})) {
    const parsed = parseProviderModelRef(modelRef);
    if (
      parsed?.provider === OPENAI_PROVIDER_ID &&
      isCodexRuntimeSelection(modelConfig?.agentRuntime?.id)
    ) {
      return true;
    }
  }
  return false;
}

function openAiWildcardRuntimePolicy(
  models: Record<string, AgentModelEntryConfig> | undefined,
): AgentRuntimePolicyConfig | undefined {
  for (const [modelRef, modelConfig] of Object.entries(models ?? {})) {
    const parsed = parseProviderModelRef(modelRef);
    if (
      parsed?.provider === OPENAI_PROVIDER_ID &&
      parsed.model === "*" &&
      modelConfig?.agentRuntime?.id?.trim()
    ) {
      return modelConfig.agentRuntime;
    }
  }
  return undefined;
}

function openAiDefaultRouteRuntimePolicies(cfg: OpenClawConfig): AgentRuntimePolicyConfig[] {
  return [
    openAiWildcardRuntimePolicy(cfg.agents?.defaults?.models),
    openAiProviderRuntimePolicy(cfg),
  ].filter((policy): policy is AgentRuntimePolicyConfig => Boolean(policy));
}

export function configExplicitlyKeepsCodexUnavailableForOpenAi(cfg: OpenClawConfig): boolean {
  if (openAiHasCodexRuntimePolicy(cfg)) {
    return false;
  }
  const policies = openAiDefaultRouteRuntimePolicies(cfg);
  return policies.some((policy) => isOpenClawRuntimeSelection(policy.id));
}

export function shouldSuppressMissingCodexPluginDiagnostics(cfg: OpenClawConfig): boolean {
  const entryEnabled = codexPluginEntryEnabled(cfg);
  if (entryEnabled === true) {
    return false;
  }
  return entryEnabled === false || configExplicitlyKeepsCodexUnavailableForOpenAi(cfg);
}
