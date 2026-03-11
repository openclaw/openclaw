import {
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  upsertAuthProfileWithLock,
  type ApiKeyCredential,
} from "../agents/auth-profiles.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store.js";
import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { buildVllmProvider } from "../agents/models-config.providers.discovery.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { hasConfiguredSecretInput, type SecretInput } from "../config/types.secrets.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  applyProviderDefaultModel,
  promptAndConfigureOpenAICompatibleSelfHostedProvider,
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "./self-hosted-provider-setup.js";

export const VLLM_DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
export const VLLM_DEFAULT_CONTEXT_WINDOW = SELF_HOSTED_DEFAULT_CONTEXT_WINDOW;
export const VLLM_DEFAULT_MAX_TOKENS = SELF_HOSTED_DEFAULT_MAX_TOKENS;
export const VLLM_DEFAULT_COST = SELF_HOSTED_DEFAULT_COST;

const VLLM_MANAGED_KIND = "vllm";
const VLLM_ACTION_USE_EXISTING = "__use_existing_model__";
const VLLM_ACTION_ADD_ENDPOINT = "__add_endpoint__";
const VLLM_ACTION_MANAGE_ENDPOINT = "__manage_endpoint__";
const VLLM_ACTION_DONE = "__done__";
const VLLM_ENDPOINT_USE_MODEL = "__endpoint_use_model__";
const VLLM_ENDPOINT_UPDATE = "__endpoint_update__";
const VLLM_ENDPOINT_DELETE = "__endpoint_delete__";

type VllmSetupResult = {
  config: OpenClawConfig;
  modelId?: string;
  modelRef?: string;
};

type ManagedVllmProvider = {
  providerKey: string;
  profileId?: string;
  credential?: ApiKeyCredential;
  configuredApiKey?: SecretInput;
  baseUrl: string;
  models: ModelDefinitionConfig[];
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isManagedVllmProviderKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return normalized === "vllm" || normalized.startsWith("vllm-");
}

function createManualModelDefinition(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: VLLM_DEFAULT_COST,
    contextWindow: VLLM_DEFAULT_CONTEXT_WINDOW,
    maxTokens: VLLM_DEFAULT_MAX_TOKENS,
  };
}

function resolveConfiguredScanApiKey(apiKey?: SecretInput): string | undefined {
  if (typeof apiKey !== "string") {
    return undefined;
  }
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return undefined;
  }
  if (isNonSecretApiKeyMarker(trimmed, { includeEnvVarName: false })) {
    return undefined;
  }
  if (isNonSecretApiKeyMarker(trimmed)) {
    return normalizeOptionalSecretInput(process.env[trimmed]);
  }
  return trimmed;
}

function parseManualModelIds(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function collectManagedVllmProviders(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
}): ManagedVllmProvider[] {
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const providers = params.cfg.models?.providers ?? {};
  const profileInfo = new Map<string, { profileId: string; credential: ApiKeyCredential }>();

  for (const [profileId, credential] of Object.entries(authStore.profiles)) {
    if (credential.type !== "api_key") {
      continue;
    }
    if (
      credential.metadata?.kind !== VLLM_MANAGED_KIND &&
      !isManagedVllmProviderKey(credential.provider)
    ) {
      continue;
    }
    if (!profileInfo.has(credential.provider)) {
      profileInfo.set(credential.provider, { profileId, credential });
    }
  }

  return Object.entries(providers)
    .filter(([providerKey, provider]) => {
      if (!provider?.baseUrl?.trim()) {
        return false;
      }
      return isManagedVllmProviderKey(providerKey) || profileInfo.has(providerKey);
    })
    .map(([providerKey, provider]) => {
      const matchedProfile = profileInfo.get(providerKey);
      return {
        providerKey,
        profileId: matchedProfile?.profileId,
        credential: matchedProfile?.credential,
        configuredApiKey: provider.apiKey,
        baseUrl: normalizeBaseUrl(provider.baseUrl),
        models: Array.isArray(provider.models) ? provider.models : [],
      } satisfies ManagedVllmProvider;
    })
    .toSorted((left, right) => left.providerKey.localeCompare(right.providerKey));
}

function buildEndpointHint(entry: ManagedVllmProvider): string {
  const modelCount = entry.models.length;
  return `${entry.baseUrl} · ${modelCount} model${modelCount === 1 ? "" : "s"}`;
}

function generateNextVllmProviderKey(existingKeys: Iterable<string>): string {
  const used = new Set(Array.from(existingKeys, (value) => value.trim()).filter(Boolean));
  if (!used.has("vllm")) {
    return "vllm";
  }
  let suffix = 2;
  while (used.has(`vllm-${suffix}`)) {
    suffix += 1;
  }
  return `vllm-${suffix}`;
}

function buildProfileId(providerKey: string): string {
  return `${providerKey}:default`;
}

async function resolveStoredApiKey(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore: ReturnType<typeof ensureAuthProfileStore>;
  profileId?: string;
}): Promise<string | undefined> {
  if (!params.profileId) {
    return undefined;
  }
  try {
    const resolved = await resolveApiKeyForProfile({
      cfg: params.cfg,
      store: params.authStore,
      profileId: params.profileId,
      agentDir: params.agentDir,
    });
    return resolved?.apiKey?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function promptVllmModels(params: {
  prompter: WizardPrompter;
  discoveredModels: ModelDefinitionConfig[];
  existingModels: ModelDefinitionConfig[];
}): Promise<{ models: ModelDefinitionConfig[]; primaryModelId: string }> {
  const discoveredById = new Map(
    params.discoveredModels.map((model) => [model.id, model] as const),
  );
  const existingIds = new Set(params.existingModels.map((model) => model.id));

  let selectedIds: string[] = [];
  if (params.discoveredModels.length > 0) {
    const initialValues = params.discoveredModels
      .map((model) => model.id)
      .filter((id) => existingIds.has(id));
    while (selectedIds.length === 0) {
      selectedIds = await params.prompter.multiselect({
        message: "Select vLLM models to configure",
        options: params.discoveredModels.map((model) => ({
          value: model.id,
          label: model.id,
          hint: model.reasoning ? "reasoning" : undefined,
        })),
        initialValues:
          initialValues.length > 0
            ? initialValues
            : [params.discoveredModels[0]?.id].filter(Boolean),
        searchable: true,
      });
      if (selectedIds.length === 0) {
        await params.prompter.note("Select at least one model to continue.", "vLLM models");
      }
    }
  } else {
    const manualModels = await params.prompter.text({
      message: "vLLM models (comma-separated)",
      initialValue: params.existingModels.map((model) => model.id).join(", "),
      placeholder: "meta-llama/Meta-Llama-3-8B-Instruct, deepseek-ai/DeepSeek-R1",
      validate: (value) =>
        parseManualModelIds(value).length > 0 ? undefined : "Enter at least one model ID",
    });
    selectedIds = parseManualModelIds(String(manualModels ?? ""));
  }

  const selectedModels = selectedIds.map(
    (id) => discoveredById.get(id) ?? createManualModelDefinition(id),
  );
  const primaryModelId =
    selectedModels.length === 1
      ? selectedModels[0].id
      : await params.prompter.select({
          message: "Default vLLM model",
          options: selectedModels.map((model) => ({
            value: model.id,
            label: model.id,
            hint: model.reasoning ? "reasoning" : undefined,
          })),
          initialValue:
            params.existingModels.find((model) => selectedIds.includes(model.id))?.id ??
            selectedModels[0]?.id,
        });

  return { models: selectedModels, primaryModelId };
}

function updateVllmProviderConfig(params: {
  cfg: OpenClawConfig;
  providerKey: string;
  baseUrl: string;
  models: ModelDefinitionConfig[];
  apiKey?: SecretInput;
}): OpenClawConfig {
  const providers = { ...params.cfg.models?.providers };
  const existingProvider = providers[params.providerKey];
  const { apiKey: existingApiKey, ...restProvider } = existingProvider ?? {};
  providers[params.providerKey] = {
    ...restProvider,
    ...(params.apiKey
      ? { apiKey: params.apiKey }
      : existingApiKey
        ? { apiKey: existingApiKey }
        : {}),
    baseUrl: params.baseUrl,
    api: "openai-completions",
    models: params.models,
  };

  return {
    ...params.cfg,
    models: {
      ...params.cfg.models,
      mode: params.cfg.models?.mode ?? "merge",
      providers,
    },
  };
}

function removeVllmProviderConfig(cfg: OpenClawConfig, providerKey: string): OpenClawConfig {
  const providers = { ...cfg.models?.providers };
  delete providers[providerKey];
  const nextModels = {
    ...cfg.models,
    ...(Object.keys(providers).length > 0 ? { providers } : {}),
  };
  if (Object.keys(providers).length === 0) {
    delete nextModels.providers;
  }

  return {
    ...cfg,
    ...(cfg.models || Object.keys(nextModels).length > 0 ? { models: nextModels } : {}),
  };
}

async function saveVllmCredential(params: {
  providerKey: string;
  baseUrl: string;
  apiKey?: string;
  existing?: ManagedVllmProvider;
  allowMissingCredential?: boolean;
  agentDir?: string;
}): Promise<void> {
  const profileId = params.existing?.profileId ?? buildProfileId(params.providerKey);
  const existingCredential = params.existing?.credential;
  const nextApiKey = params.apiKey?.trim();
  if (!nextApiKey && !existingCredential) {
    if (params.allowMissingCredential) {
      return;
    }
    throw new Error("A vLLM API key is required for new endpoints.");
  }

  const credential: ApiKeyCredential = nextApiKey
    ? {
        type: "api_key",
        provider: params.providerKey,
        key: nextApiKey,
        metadata: {
          ...existingCredential?.metadata,
          kind: VLLM_MANAGED_KIND,
          baseUrl: params.baseUrl,
        },
      }
    : {
        type: "api_key",
        provider: params.providerKey,
        ...(existingCredential?.key ? { key: existingCredential.key } : {}),
        ...(existingCredential?.keyRef ? { keyRef: existingCredential.keyRef } : {}),
        ...(existingCredential?.email ? { email: existingCredential.email } : {}),
        metadata: {
          ...existingCredential?.metadata,
          kind: VLLM_MANAGED_KIND,
          baseUrl: params.baseUrl,
        },
      };

  await upsertAuthProfileWithLock({
    profileId,
    credential,
    agentDir: params.agentDir,
  });
}

async function removeVllmCredential(params: {
  providerKey: string;
  agentDir?: string;
}): Promise<void> {
  await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
      const profileIds = listProfilesForProvider(store, params.providerKey);
      let changed = false;
      for (const profileId of profileIds) {
        delete store.profiles[profileId];
        changed = true;
      }
      if (store.order?.[params.providerKey]) {
        delete store.order[params.providerKey];
        changed = true;
      }
      if (store.lastGood?.[params.providerKey]) {
        delete store.lastGood[params.providerKey];
        changed = true;
      }
      if (store.usageStats) {
        for (const profileId of profileIds) {
          if (store.usageStats[profileId]) {
            delete store.usageStats[profileId];
            changed = true;
          }
        }
      }
      return changed;
    },
  });
}

async function configureEndpoint(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  agentDir?: string;
  existing?: ManagedVllmProvider;
}): Promise<{ config: OpenClawConfig; modelId: string; modelRef: string }> {
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const providerKey =
    params.existing?.providerKey ??
    generateNextVllmProviderKey(Object.keys(params.cfg.models?.providers ?? {}));
  const canKeepExistingApiKey = Boolean(
    params.existing?.profileId || hasConfiguredSecretInput(params.existing?.configuredApiKey),
  );

  const baseUrlRaw = await params.prompter.text({
    message: "vLLM base URL",
    initialValue: params.existing?.baseUrl ?? VLLM_DEFAULT_BASE_URL,
    placeholder: VLLM_DEFAULT_BASE_URL,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const baseUrl = normalizeBaseUrl(String(baseUrlRaw ?? ""));

  const apiKeyRaw = await params.prompter.text({
    message: canKeepExistingApiKey ? "vLLM API key (blank to keep current)" : "vLLM API key",
    placeholder: canKeepExistingApiKey
      ? "Leave blank to keep the saved key"
      : "sk-... (or any non-empty string)",
    validate: (value) => {
      if (canKeepExistingApiKey) {
        return undefined;
      }
      return value?.trim() ? undefined : "Required";
    },
  });
  const apiKey = String(apiKeyRaw ?? "").trim();
  const scanApiKey =
    apiKey ||
    (await resolveStoredApiKey({
      cfg: params.cfg,
      agentDir: params.agentDir,
      authStore,
      profileId: params.existing?.profileId,
    })) ||
    resolveConfiguredScanApiKey(params.existing?.configuredApiKey);

  const progress = params.prompter.progress("Scanning vLLM models...");
  const discoveredProvider = await buildVllmProvider({
    baseUrl,
    apiKey: scanApiKey,
  });
  progress.stop(
    discoveredProvider.models.length > 0
      ? `Found ${discoveredProvider.models.length} vLLM model${discoveredProvider.models.length === 1 ? "" : "s"}.`
      : "No models discovered; manual entry required.",
  );

  const { models, primaryModelId } = await promptVllmModels({
    prompter: params.prompter,
    discoveredModels: discoveredProvider.models,
    existingModels: params.existing?.models ?? [],
  });

  await saveVllmCredential({
    providerKey,
    baseUrl,
    apiKey,
    existing: params.existing,
    allowMissingCredential: canKeepExistingApiKey,
    agentDir: params.agentDir,
  });

  const nextConfig = updateVllmProviderConfig({
    cfg: params.cfg,
    providerKey,
    baseUrl,
    models,
    ...(apiKey ? { apiKey } : {}),
  });

  return {
    config: nextConfig,
    modelId: primaryModelId,
    modelRef: `${providerKey}/${primaryModelId}`,
  };
}

async function promptConfiguredVllmModel(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  providers: ManagedVllmProvider[];
}): Promise<{ config: OpenClawConfig; modelId: string; modelRef: string }> {
  const options = params.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      value: `${provider.providerKey}/${model.id}`,
      label: `${provider.providerKey}/${model.id}`,
      hint: provider.baseUrl,
    })),
  );
  const selection = await params.prompter.select({
    message: "Choose a configured vLLM model",
    options,
  });
  const slash = String(selection).indexOf("/");
  const modelRef = String(selection);
  return {
    config: params.cfg,
    modelId: slash === -1 ? modelRef : modelRef.slice(slash + 1),
    modelRef,
  };
}

export async function promptAndConfigureVllm(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  agentDir?: string;
}): Promise<VllmSetupResult> {
  let nextConfig = params.cfg;

  while (true) {
    const providers = collectManagedVllmProviders({
      cfg: nextConfig,
      agentDir: params.agentDir,
    });
    const hasConfiguredModels = providers.some((provider) => provider.models.length > 0);
    const action = await params.prompter.select({
      message: providers.length === 0 ? "No vLLM endpoints configured" : "vLLM setup",
      options: [
        ...(providers.length > 0
          ? [
              ...(hasConfiguredModels
                ? [
                    {
                      value: VLLM_ACTION_USE_EXISTING,
                      label: "Use a configured vLLM model",
                      hint: "Select from already saved endpoints/models",
                    },
                  ]
                : []),
              {
                value: VLLM_ACTION_MANAGE_ENDPOINT,
                label: "Manage existing vLLM endpoints",
                hint: "Update models, change base URL, or delete an endpoint",
              },
            ]
          : []),
        {
          value: VLLM_ACTION_ADD_ENDPOINT,
          label: "Add a vLLM endpoint",
          hint: "Configure another base URL and import models",
        },
        {
          value: VLLM_ACTION_DONE,
          label: "Done / go back",
          hint:
            providers.length === 0 ? "Exit without configuring vLLM" : "Keep current vLLM setup",
        },
      ],
      initialValue: hasConfiguredModels ? VLLM_ACTION_USE_EXISTING : VLLM_ACTION_ADD_ENDPOINT,
    });

    if (action === VLLM_ACTION_DONE) {
      return { config: nextConfig };
    }

    if (action === VLLM_ACTION_USE_EXISTING) {
      return await promptConfiguredVllmModel({
        cfg: nextConfig,
        prompter: params.prompter,
        providers: providers.filter((provider) => provider.models.length > 0),
      });
    }

    if (action === VLLM_ACTION_ADD_ENDPOINT) {
      return await configureEndpoint({
        cfg: nextConfig,
        prompter: params.prompter,
        agentDir: params.agentDir,
      });
    }

    const selectedProviderKey = await params.prompter.select({
      message: "Select a vLLM endpoint",
      options: providers.map((provider) => ({
        value: provider.providerKey,
        label: provider.providerKey,
        hint: buildEndpointHint(provider),
      })),
    });
    const selectedProvider = providers.find(
      (provider) => provider.providerKey === selectedProviderKey,
    );
    if (!selectedProvider) {
      continue;
    }

    const endpointAction = await params.prompter.select({
      message: `Manage ${selectedProvider.providerKey}`,
      options: [
        ...(selectedProvider.models.length > 0
          ? [
              {
                value: VLLM_ENDPOINT_USE_MODEL,
                label: "Use a configured model",
                hint: `${selectedProvider.models.length} saved model${selectedProvider.models.length === 1 ? "" : "s"}`,
              },
            ]
          : []),
        {
          value: VLLM_ENDPOINT_UPDATE,
          label: "Update endpoint and rescan models",
          hint: selectedProvider.baseUrl,
        },
        {
          value: VLLM_ENDPOINT_DELETE,
          label: "Delete endpoint",
          hint: "Remove this base URL and its saved models",
        },
      ],
      initialValue:
        selectedProvider.models.length > 0 ? VLLM_ENDPOINT_USE_MODEL : VLLM_ENDPOINT_UPDATE,
    });

    if (endpointAction === VLLM_ENDPOINT_USE_MODEL) {
      return await promptConfiguredVllmModel({
        cfg: nextConfig,
        prompter: params.prompter,
        providers: [selectedProvider],
      });
    }

    if (endpointAction === VLLM_ENDPOINT_UPDATE) {
      return await configureEndpoint({
        cfg: nextConfig,
        prompter: params.prompter,
        agentDir: params.agentDir,
        existing: selectedProvider,
      });
    }

    const confirmDelete = await params.prompter.confirm({
      message: `Delete ${selectedProvider.providerKey} (${selectedProvider.baseUrl})?`,
      initialValue: false,
    });
    if (!confirmDelete) {
      continue;
    }

    await removeVllmCredential({
      providerKey: selectedProvider.providerKey,
      agentDir: params.agentDir,
    });
    nextConfig = removeVllmProviderConfig(nextConfig, selectedProvider.providerKey);
    await params.prompter.note(
      `Removed ${selectedProvider.providerKey} (${selectedProvider.baseUrl}).`,
      "vLLM endpoint removed",
    );
  }
}

export { applyProviderDefaultModel as applyVllmDefaultModel };
