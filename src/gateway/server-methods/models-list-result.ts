// Model list result building resolves visible model catalogs for an agent and
// strips runtime-only provider params before sending the browse API payload.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  resolveAuthProfileOrder,
  type AuthProfileCredential,
  type AuthProfileStore,
} from "../../agents/auth-profiles.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { NON_ENV_SECRETREF_MARKER } from "../../agents/model-auth-markers.js";
import { hasRuntimeAvailableProviderAuth } from "../../agents/model-auth.js";
import {
  loadModelCatalogForBrowse,
  type ModelCatalogBrowseView,
} from "../../agents/model-catalog-browse.js";
import {
  modelCatalogEntryHasProviderAuth,
  type ProviderAuthChecker,
  resolveVisibleModelCatalog,
} from "../../agents/model-catalog-visibility.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isSecretRef } from "../../config/types.secrets.js";
import type { GatewayRequestContext } from "./types.js";

type ModelsListView = ModelCatalogBrowseView;
type ModelsListEntry = ModelCatalogEntry & { available?: boolean };

let loggedSlowModelsListCatalog = false;
const OAUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Unknown views are rejected by protocol validation first; this helper keeps the
// handler default explicit for older clients that omit the field.
function resolveModelsListView(params: Record<string, unknown>): ModelsListView {
  return typeof params.view === "string" ? (params.view as ModelsListView) : "default";
}

// Runtime-only model params are useful inside provider routing, but exposing
// them here would leak provider invocation details into the Control UI API.
function omitRuntimeModelParams(entry: ModelCatalogEntry): ModelCatalogEntry {
  const { params: _params, ...rest } = entry as ModelCatalogEntry & {
    params?: Record<string, unknown>;
  };
  return rest;
}

function modelCatalogEntryHasUnknownSecretRefAvailability(
  cfg: OpenClawConfig,
  entry: ModelCatalogEntry,
): boolean {
  const providerId = normalizeProviderId(entry.provider);
  const provider = Object.entries(cfg.models?.providers ?? {}).find(
    ([id]) => normalizeProviderId(id) === providerId,
  )?.[1];
  const apiKey = provider?.apiKey;
  return apiKey === NON_ENV_SECRETREF_MARKER || (isSecretRef(apiKey) && apiKey.source !== "env");
}

function createInFlightProviderAuthChecker(
  providerAuthChecker: ProviderAuthChecker,
): ProviderAuthChecker {
  const pending = new Map<string, Promise<boolean>>();
  return (provider, modelApi) => {
    const key = `${normalizeProviderId(provider)}\0${modelApi ?? ""}`;
    const cached = pending.get(key);
    if (cached) {
      return cached;
    }
    const next = Promise.resolve(providerAuthChecker(provider, modelApi));
    pending.set(key, next);
    return next;
  };
}

function hasLiteralSecret(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function profileModeAllowedForModel(
  provider: string,
  modelApi: string | undefined,
  mode: AuthProfileCredential["type"],
): boolean {
  return (
    normalizeProviderId(provider) !== "openai" ||
    modelApi === undefined ||
    modelApi === "openai-chatgpt-responses" ||
    mode === "api_key"
  );
}

function profileHasReadOnlyAvailableAuth(params: {
  credential: AuthProfileCredential;
  provider: string;
  modelApi?: string;
  now: number;
}): boolean {
  if (!profileModeAllowedForModel(params.provider, params.modelApi, params.credential.type)) {
    return false;
  }
  if (params.credential.type === "api_key") {
    return hasLiteralSecret(params.credential.key);
  }
  if (params.credential.type === "token") {
    return (
      hasLiteralSecret(params.credential.token) &&
      (params.credential.expires === undefined || params.credential.expires > params.now)
    );
  }
  return (
    hasLiteralSecret(params.credential.access) &&
    params.credential.expires > params.now + OAUTH_REFRESH_MARGIN_MS
  );
}

function hasReadOnlyAvailableProfileAuth(params: {
  provider: string;
  modelApi?: string;
  cfg: OpenClawConfig;
  store: AuthProfileStore;
}): boolean {
  const now = Date.now();
  return resolveAuthProfileOrder({
    cfg: params.cfg,
    store: params.store,
    provider: params.provider,
  }).some((profileId) => {
    const credential = params.store.profiles[profileId];
    return (
      credential !== undefined &&
      profileHasReadOnlyAvailableAuth({
        credential,
        provider: params.provider,
        modelApi: params.modelApi,
        now,
      })
    );
  });
}

function createModelsListProviderAuthChecker(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
}): ProviderAuthChecker {
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
    allowKeychainPrompt: false,
    readOnly: true,
    syncExternalCli: false,
  });
  return createInFlightProviderAuthChecker(
    (provider, modelApi) =>
      hasRuntimeAvailableProviderAuth({
        provider,
        modelApi,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        allowPluginSyntheticAuth: false,
      }) ||
      hasReadOnlyAvailableProfileAuth({
        provider,
        modelApi,
        cfg: params.cfg,
        store,
      }),
  );
}

async function buildPublicModelsListEntry(params: {
  entry: ModelCatalogEntry;
  cfg: OpenClawConfig;
  providerAuthChecker?: ProviderAuthChecker;
}): Promise<ModelsListEntry> {
  const publicEntry = omitRuntimeModelParams(params.entry);
  if (modelCatalogEntryHasUnknownSecretRefAvailability(params.cfg, params.entry)) {
    return publicEntry;
  }
  if (!params.providerAuthChecker) {
    return publicEntry;
  }
  return {
    ...publicEntry,
    available: await modelCatalogEntryHasProviderAuth(params.providerAuthChecker, params.entry),
  };
}

async function buildPublicModelsListEntries(params: {
  catalog: ModelCatalogEntry[];
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
}): Promise<ModelsListEntry[]> {
  const providerAuthChecker = createModelsListProviderAuthChecker(params);
  return await Promise.all(
    params.catalog.map((entry) =>
      buildPublicModelsListEntry({
        entry,
        cfg: params.cfg,
        providerAuthChecker,
      }),
    ),
  );
}

export async function buildModelsListResult(params: {
  context: GatewayRequestContext;
  agentId?: string;
  params: Record<string, unknown>;
}): Promise<{ models: ModelsListEntry[] }> {
  const cfg = params.context.getRuntimeConfig();
  const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId) ?? resolveDefaultAgentWorkspaceDir();
  const view = resolveModelsListView(params.params);
  const catalog = await loadModelCatalogForBrowse({
    cfg,
    view,
    loadCatalog: params.context.loadGatewayModelCatalog,
    onTimeout: (timeoutMs) => {
      if (loggedSlowModelsListCatalog) {
        return;
      }
      loggedSlowModelsListCatalog = true;
      params.context.logGateway.debug(
        `models.list continuing without model catalog after ${timeoutMs}ms`,
      );
    },
  });
  if (view === "all") {
    return {
      models: await buildPublicModelsListEntries({ catalog, cfg, agentId, workspaceDir }),
    };
  }
  const models = await resolveVisibleModelCatalog({
    cfg,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: resolveAgentEffectiveModelPrimary(cfg, agentId),
    agentId,
    workspaceDir,
    view,
    runtimeAuthDiscovery: false,
  });
  return {
    models: await buildPublicModelsListEntries({
      catalog: models,
      cfg,
      agentId,
      workspaceDir,
    }),
  };
}
