import type { GatewayBrowserClient } from "../gateway.ts";
import type { ConfigSnapshot, ModelCatalogEntry } from "../types.ts";
import { loadModels } from "./models.ts";
import { type ProviderModel, getProvider, PROVIDER_REGISTRY } from "./provider-registry.ts";

export type ApiKeyState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  configSnapshot: ConfigSnapshot | null;
  apiKeyPopoverOpen: boolean;
  apiKeyProvider: string;
  apiKeyValue: string;
  apiKeySaving: boolean;
  apiKeyError: string | null;
  apiKeySuccess: string | null;
  apiKeyFetchedModels: ProviderModel[];
  apiKeySelectedModel: string | null;
  apiKeyView: "providers" | "configure";
  configLoading: boolean;
  chatModelCatalog: ModelCatalogEntry[];
  chatModelsLoading: boolean;
  sessionKey: string;
};

export async function ensureConfigLoaded(state: ApiKeyState) {
  if (state.configSnapshot || !state.client || !state.connected) {
    return;
  }
  state.configLoading = true;
  try {
    const res = await state.client.request<ConfigSnapshot>("config.get", {});
    state.configSnapshot = res;
  } catch {
    // config load failed, will show error on save
  } finally {
    state.configLoading = false;
  }
}

/**
 * Save the API key WITH the curated model catalog into gateway config.
 * No CORS issues — we write the models directly, gateway uses them immediately.
 *
 * Flow:
 * 1. Write apiKey + baseUrl + api + models[] into config.patch
 * 2. Gateway restarts and sees the provider + models
 * 3. Show curated models instantly for user to pick a default
 * 4. Set selected model as agents.defaults.model
 */
export async function saveApiKeyAndDetectModels(state: ApiKeyState) {
  if (!state.client || !state.connected) {
    state.apiKeyError = "Not connected to gateway";
    return;
  }
  const providerId = state.apiKeyProvider.trim();
  const apiKey = state.apiKeyValue.trim();
  if (!providerId) {
    state.apiKeyError = "Select a provider";
    return;
  }
  if (!apiKey) {
    state.apiKeyError = "Enter an API key";
    return;
  }

  if (!state.configSnapshot) {
    await ensureConfigLoaded(state);
  }
  const baseHash = state.configSnapshot?.hash;
  if (!baseHash) {
    state.apiKeyError = "Config not loaded. Try again.";
    return;
  }

  const provider = getProvider(providerId);
  if (!provider) {
    state.apiKeyError = "Unknown provider";
    return;
  }

  state.apiKeySaving = true;
  state.apiKeyError = null;
  state.apiKeySuccess = null;
  state.apiKeyFetchedModels = [];
  state.apiKeySelectedModel = null;

  try {
    // Build full provider config with curated models
    const providerConfig: Record<string, unknown> = {
      apiKey,
      baseUrl: provider.baseUrl,
      api: provider.api,
      models: provider.models,
    };

    // Set the default model for this provider
    const defaultModelId = provider.defaultModel ?? provider.models[0]?.id;
    const defaultModelRef = defaultModelId ? `${providerId}/${defaultModelId}` : undefined;

    const patchObj: Record<string, unknown> = {
      models: { providers: { [providerId]: providerConfig } },
    };

    // Also set as default agent model (write to model.primary to preserve fallbacks)
    if (defaultModelRef) {
      patchObj.agents = { defaults: { model: { primary: defaultModelRef } } };
    }

    const patch = JSON.stringify(patchObj);
    await state.client.request("config.patch", { raw: patch, baseHash });

    // Reload config
    const configRes = await state.client.request<ConfigSnapshot>("config.get", {});
    state.configSnapshot = configRes;

    // Show curated models instantly (no waiting for gateway restart)
    const curatedModels: ProviderModel[] = provider.models.map((m) => ({
      id: `${providerId}/${m.id}`,
      name: m.name,
      contextWindow: m.contextWindow,
      owned_by: providerId,
    }));

    state.apiKeyFetchedModels = curatedModels;
    state.apiKeySelectedModel = defaultModelRef ?? curatedModels[0]?.id ?? null;
    state.apiKeyValue = "";
    state.apiKeySuccess = `Saved! ${curatedModels.length} model${curatedModels.length !== 1 ? "s" : ""} available · default: ${provider.models.find((m) => `${providerId}/${m.id}` === state.apiKeySelectedModel)?.name ?? defaultModelId}`;

    // Refresh the main chat model dropdown so user sees models everywhere
    refreshChatModelCatalog(state).catch(() => {});

    // Update current session to use the new default model
    if (defaultModelRef && state.sessionKey) {
      state.client.request("sessions.patch", {
        key: state.sessionKey,
        model: defaultModelRef,
      }).catch(() => {});
    }
  } catch (err) {
    state.apiKeyError = String(err);
  } finally {
    state.apiKeySaving = false;
  }
}

/** Refresh the chat model dropdown from the gateway. */
async function refreshChatModelCatalog(state: ApiKeyState) {
  if (!state.client || !state.connected) return;
  state.chatModelsLoading = true;
  try {
    state.chatModelCatalog = await loadModels(state.client);
  } finally {
    state.chatModelsLoading = false;
  }
}

/** Set the selected model as the default agent model. */
export async function setDefaultModel(state: ApiKeyState) {
  if (!state.client || !state.connected || !state.apiKeySelectedModel) return;

  if (!state.configSnapshot) {
    await ensureConfigLoaded(state);
  }
  const baseHash = state.configSnapshot?.hash;
  if (!baseHash) return;

  state.apiKeySaving = true;
  state.apiKeyError = null;
  try {
    const patch = JSON.stringify({
      agents: { defaults: { model: { primary: state.apiKeySelectedModel } } },
    });
    await state.client.request("config.patch", { raw: patch, baseHash });
    const configRes = await state.client.request<ConfigSnapshot>("config.get", {});
    state.configSnapshot = configRes;
    state.apiKeySuccess = `Default model: ${state.apiKeySelectedModel}`;

    // Update current session to use this model
    if (state.sessionKey) {
      await state.client.request("sessions.patch", {
        key: state.sessionKey,
        model: state.apiKeySelectedModel,
      });
    }

    // Refresh the main chat model dropdown
    await refreshChatModelCatalog(state);
  } catch (err) {
    state.apiKeyError = String(err);
  } finally {
    state.apiKeySaving = false;
  }
}

/** Check which providers already have keys configured in the config snapshot. */
export function getConfiguredProviders(state: ApiKeyState): Set<string> {
  const configured = new Set<string>();
  const config = state.configSnapshot?.config as Record<string, unknown> | undefined;
  if (!config?.models || typeof config.models !== "object") return configured;
  const models = config.models as Record<string, unknown>;

  const providers = (models.providers as Record<string, unknown>) ?? {};
  for (const [key, val] of Object.entries(providers)) {
    if (val && typeof val === "object") {
      const p = val as Record<string, unknown>;
      if (p.apiKey || p.auth) {
        configured.add(key);
      }
    }
  }
  // Also check old flat format for backward compat
  for (const pid of PROVIDER_REGISTRY.map((p) => p.id)) {
    if (models[pid] && typeof models[pid] === "object") {
      const p = models[pid] as Record<string, unknown>;
      if (p.apiKey || p.auth) {
        configured.add(pid);
      }
    }
  }
  return configured;
}
