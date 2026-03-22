import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { normalizeProviderId, parseModelRef } from "../agents/model-selection.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type {
  AgentConfig,
  AgentDefaultsConfig,
  ConfigValidationIssue,
  OpenClawConfig,
} from "../config/types.js";

const DEFAULT_ALLOWED_LOCAL_PROVIDERS = ["ollama"] as const;
const ALLOWED_PRIVATE_EMBEDDING_PROVIDERS = new Set(["local", "ollama"]);

function isPrivateModeEnabled(config: OpenClawConfig): boolean {
  return config.privateMode?.enabled === true;
}

function isPrivateModeLocalOnlyEnabled(config: OpenClawConfig): boolean {
  if (!isPrivateModeEnabled(config)) {
    return false;
  }
  return config.privateMode?.localOnly?.enabled ?? true;
}

function shouldFailOnDisallowedProviders(config: OpenClawConfig): boolean {
  if (!isPrivateModeEnabled(config)) {
    return false;
  }
  return config.privateMode?.localOnly?.failOnDisallowedProviders ?? true;
}

export function getPrivateModeAllowedProviders(config: OpenClawConfig): string[] {
  const configured = config.privateMode?.localOnly?.allowedProviders
    ?.map((value) => normalizeProviderId(String(value ?? "").trim()))
    .filter(Boolean);
  if (configured && configured.length > 0) {
    return Array.from(new Set(configured));
  }
  return [...DEFAULT_ALLOWED_LOCAL_PROVIDERS];
}

export function isProviderAllowedInPrivateMode(provider: string, config: OpenClawConfig): boolean {
  const normalized = normalizeProviderId(provider);
  if (!normalized) {
    return false;
  }
  return getPrivateModeAllowedProviders(config).includes(normalized);
}

function maybeParseModelRef(raw: string | undefined): { provider: string; model: string } | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return null;
  }
  return parseModelRef(trimmed, DEFAULT_PROVIDER);
}

function pushModelRefIssue(
  issues: ConfigValidationIssue[],
  config: OpenClawConfig,
  path: string,
  raw: string | undefined,
): void {
  if (!shouldFailOnDisallowedProviders(config)) {
    return;
  }
  const parsed = maybeParseModelRef(raw);
  if (!parsed) {
    return;
  }
  if (isProviderAllowedInPrivateMode(parsed.provider, config)) {
    return;
  }
  const allowedProviders = getPrivateModeAllowedProviders(config);
  issues.push({
    path,
    message:
      `privateMode.localOnly allows only provider ids [${allowedProviders.join(", ")}], ` +
      `but resolved model \"${parsed.provider}/${parsed.model}\" uses disallowed provider \"${parsed.provider}\".`,
    allowedValues: allowedProviders,
  });
}

function validateModelConfig(
  issues: ConfigValidationIssue[],
  config: OpenClawConfig,
  basePath: string,
  model: AgentDefaultsConfig["model"] | AgentConfig["model"] | undefined,
): void {
  pushModelRefIssue(issues, config, `${basePath}.primary`, resolveAgentModelPrimaryValue(model));
  for (const [index, fallback] of resolveAgentModelFallbackValues(model).entries()) {
    pushModelRefIssue(issues, config, `${basePath}.fallbacks.${index}`, fallback);
  }
}

function validateConfiguredModelCatalog(
  issues: ConfigValidationIssue[],
  config: OpenClawConfig,
  models: AgentDefaultsConfig["models"] | undefined,
): void {
  for (const key of Object.keys(models ?? {})) {
    pushModelRefIssue(issues, config, `agents.defaults.models.${key}`, key);
  }
}

function validateConfiguredProviders(
  issues: ConfigValidationIssue[],
  config: OpenClawConfig,
): void {
  if (!shouldFailOnDisallowedProviders(config)) {
    return;
  }
  const allowedProviders = getPrivateModeAllowedProviders(config);
  for (const providerId of Object.keys(config.models?.providers ?? {})) {
    const normalized = normalizeProviderId(providerId);
    if (!normalized || allowedProviders.includes(normalized)) {
      continue;
    }
    issues.push({
      path: `models.providers.${providerId}`,
      message:
        `privateMode.localOnly allows only provider ids [${allowedProviders.join(", ")}], ` +
        `but models.providers configures disallowed provider \"${providerId}\".`,
      allowedValues: allowedProviders,
    });
  }
}

function validateMemorySearchConfig(
  issues: ConfigValidationIssue[],
  config: OpenClawConfig,
  pathPrefix: string,
  memorySearch: AgentDefaultsConfig["memorySearch"] | AgentConfig["memorySearch"] | undefined,
): void {
  if (!memorySearch) {
    return;
  }

  const provider = memorySearch.provider;
  if (provider && !ALLOWED_PRIVATE_EMBEDDING_PROVIDERS.has(provider)) {
    issues.push({
      path: `${pathPrefix}.provider`,
      message: `privateMode requires memorySearch.provider to be one of [local, ollama], but found \"${provider}\".`,
      allowedValues: ["local", "ollama"],
    });
  }

  const fallback = memorySearch.fallback;
  if (fallback && fallback !== "none" && !ALLOWED_PRIVATE_EMBEDDING_PROVIDERS.has(fallback)) {
    issues.push({
      path: `${pathPrefix}.fallback`,
      message: `privateMode requires memorySearch.fallback to be one of [local, ollama, none], but found \"${fallback}\".`,
      allowedValues: ["local", "ollama", "none"],
    });
  }

  const configuredEmbeddingProvider = config.privateMode?.embeddings?.provider;
  if (configuredEmbeddingProvider && provider && provider !== configuredEmbeddingProvider) {
    issues.push({
      path: `${pathPrefix}.provider`,
      message: `privateMode.embeddings.provider is \"${configuredEmbeddingProvider}\", so memorySearch.provider must match when set explicitly.`,
      allowedValues: [configuredEmbeddingProvider],
    });
  }
}

function validatePrivateModeEmbeddingsConfig(
  issues: ConfigValidationIssue[],
  config: OpenClawConfig,
): void {
  const provider = config.privateMode?.embeddings?.provider;
  if (!provider) {
    return;
  }
  if (ALLOWED_PRIVATE_EMBEDDING_PROVIDERS.has(provider)) {
    return;
  }
  issues.push({
    path: "privateMode.embeddings.provider",
    message: `privateMode.embeddings.provider must be one of [local, ollama], but found \"${provider}\".`,
    allowedValues: ["local", "ollama"],
  });
}

function validatePrivateModeDefaults(
  issues: ConfigValidationIssue[],
  config: OpenClawConfig,
): void {
  pushModelRefIssue(
    issues,
    config,
    "agents.defaults.model",
    resolveAgentModelPrimaryValue(config.agents?.defaults?.model) ??
      `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
  );

  validateModelConfig(issues, config, "agents.defaults.model", config.agents?.defaults?.model);
  validateModelConfig(
    issues,
    config,
    "agents.defaults.imageModel",
    config.agents?.defaults?.imageModel,
  );
  validateModelConfig(
    issues,
    config,
    "agents.defaults.imageGenerationModel",
    config.agents?.defaults?.imageGenerationModel,
  );
  validateModelConfig(
    issues,
    config,
    "agents.defaults.pdfModel",
    config.agents?.defaults?.pdfModel,
  );
  pushModelRefIssue(
    issues,
    config,
    "agents.defaults.heartbeat.model",
    config.agents?.defaults?.heartbeat?.model,
  );
  validateConfiguredModelCatalog(issues, config, config.agents?.defaults?.models);
  validateMemorySearchConfig(
    issues,
    config,
    "agents.defaults.memorySearch",
    config.agents?.defaults?.memorySearch,
  );
}

function validatePrivateModeAgents(issues: ConfigValidationIssue[], config: OpenClawConfig): void {
  for (const [index, agent] of (config.agents?.list ?? []).entries()) {
    validateModelConfig(issues, config, `agents.list.${index}.model`, agent.model);
    validateModelConfig(
      issues,
      config,
      `agents.list.${index}.subagents.model`,
      agent.subagents?.model,
    );
    validateMemorySearchConfig(
      issues,
      config,
      `agents.list.${index}.memorySearch`,
      agent.memorySearch,
    );
  }
}

export function validatePrivateModeConfig(config: OpenClawConfig): ConfigValidationIssue[] {
  if (!isPrivateModeEnabled(config)) {
    return [];
  }

  const issues: ConfigValidationIssue[] = [];

  if (isPrivateModeLocalOnlyEnabled(config)) {
    validateConfiguredProviders(issues, config);
    validatePrivateModeDefaults(issues, config);
    validatePrivateModeAgents(issues, config);
  }

  validatePrivateModeEmbeddingsConfig(issues, config);
  return issues;
}
