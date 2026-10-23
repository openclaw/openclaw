import { onTestFinished, vi } from "vitest";
import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credential-modes.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../agents/auth-profiles.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { mockRouteResolverFactory } from "../../agents/model-auth-availability.test-support.js";
import { createModelCatalogDecisions } from "../../agents/model-catalog-decisions.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { createOpenAIModelRoutesResolver } from "../../agents/openai-model-routes.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  type PreparedGatewayModelCatalogSnapshot,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
import { buildModelsListResult } from "./models-list-result.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export const WITHOUT_OPENAI_ENV_AUTH = {
  CODEX_API_KEY: undefined,
  CODEX_HOME: "/__openclaw_models_list_test__/codex",
  OPENAI_API_KEY: undefined,
  OPENAI_BASE_URL: undefined,
  OPENAI_OAUTH_TOKEN: undefined,
  CHATGPT_OAUTH_TOKEN: undefined,
} as const;

export function withModelsListState<T>(
  run: Parameters<typeof withOpenClawTestState<T>>[1],
  options: Parameters<typeof withOpenClawTestState>[0] = {},
) {
  return withOpenClawTestState({ layout: "state-only", prefix: "models-list-", ...options }, run);
}

export const modelAuthStore = (
  profiles: AuthProfileStore["profiles"],
  usageStats?: AuthProfileStore["usageStats"],
): AuthProfileStore => ({ version: 1, profiles, ...(usageStats ? { usageStats } : {}) });

export async function requestModelsList(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
  client: GatewayClient | null = null,
) {
  const { modelsHandlers } = await import("./models.js");
  const respond = vi.fn<RespondFn>();
  await modelsHandlers["models.list"]!({
    req: { type: "req", id: "models-list", method: "models.list", params },
    client,
    context,
    params,
    respond,
    isWebchatConnect: () => false,
  });
  return respond;
}

export function catalogEntry(id: string, api: ModelCatalogEntry["api"]): ModelCatalogEntry {
  return { id, name: id, provider: "openai", api };
}

export function providerCatalogEntry(provider: string, id: string): ModelCatalogEntry {
  return { ...catalogEntry(id, "openai-completions"), provider };
}

type ListModelsParams = {
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  preparedOnly?: boolean;
  includeDefaultModels?: boolean;
  catalog: ModelCatalogEntry[];
  catalogLoadDelayMs?: number;
  preparedCatalog?: ModelCatalogEntry[];
  publishedCatalog?: ModelCatalogEntry[];
  refresh?: boolean;
  staticEntries?: ModelCatalogEntry[];
  cfg?: OpenClawConfig;
  discoveryModes?: Record<string, "refreshable" | "runtime" | "static">;
  catalogComplete?: boolean;
  catalogDiagnostics?: Pick<
    PreparedGatewayModelCatalogSnapshot,
    "pendingProviders" | "providerOutcomes" | "refreshFailed"
  >;
  preparedAuthModes?: PreparedAgentCredentialModes;
  preparedAuthStore?: AuthProfileStore;
  metadataSnapshot?: PluginMetadataSnapshot;
  pluginRegistry?: PluginRegistry;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
  view?: "all" | "configured" | "provider-config" | "default";
};

const chatMetadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "openai",
      providers: ["openai"],
      modelCatalog: {
        discovery: { openai: "runtime" },
        providers: { openai: { defaultUtilityModel: "gpt-5.6-luna", models: [] } },
      },
      setup: { providers: [{ id: "openai", envVars: ["OPENAI_API_KEY"] }] },
    },
    {
      id: "anthropic",
      providers: ["anthropic"],
      cliBackends: ["claude-cli"],
      syntheticAuthRefs: ["claude-cli"],
      providerAuthAliases: { "claude-cli": "anthropic" },
      modelCatalog: { discovery: { anthropic: "refreshable", "claude-cli": "static" } },
      setup: {
        providers: [{ id: "anthropic", envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] }],
      },
    },
  ],
});

export function createModelsListTestContext(params: ListModelsParams) {
  const agentId = params.agentId ?? "main";
  const config = params.cfg ?? {};
  const agentDir = params.agentDir ?? "/tmp/models-list-openai-agent";
  setRuntimeConfigSnapshot(config);
  onTestFinished(() => clearRuntimeConfigSnapshot());
  const createCatalogSnapshot = (entries: ModelCatalogEntry[]) =>
    ({
      agentId,
      agentDir,
      catalogComplete: params.catalogComplete ?? false,
      workspaceDir: params.workspaceDir ?? "/tmp/models-list-openai-workspace",
      config,
      observationConfig: config,
      pluginRegistry: params.pluginRegistry,
      isCurrent: () => true,
      authModes: params.preparedAuthModes ?? {},
      authStore:
        params.preparedAuthStore ??
        loadAuthProfileStoreWithoutExternalProfiles(agentDir, { allowKeychainPrompt: false }),
      metadataSnapshot: params.metadataSnapshot ?? chatMetadataSnapshot,
      entries,
      routeVariants: entries,
      ...(params.staticEntries ? { staticEntries: params.staticEntries } : {}),
      authMaterializations: [],
      ...params.catalogDiagnostics,
    }) satisfies PreparedGatewayModelCatalogSnapshot;
  let publishedEntries = params.publishedCatalog ?? params.catalog;
  const loadGatewayModelCatalogSnapshot = async (loadParams?: object) => {
    if (params.catalogLoadDelayMs !== undefined) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, params.catalogLoadDelayMs);
      });
    }
    const readOnly = loadParams && "readOnly" in loadParams && loadParams.readOnly === true;
    const entries = readOnly && params.preparedCatalog ? params.preparedCatalog : params.catalog;
    if (!readOnly) {
      publishedEntries = entries;
    }
    return createCatalogSnapshot(entries);
  };
  registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
    loadDeferred: loadGatewayModelCatalogSnapshot,
    readPrepared: async () => createCatalogSnapshot(publishedEntries),
  });
  return {
    getRuntimeConfig: () => config,
    loadGatewayModelCatalogSnapshot,
    logGateway: { debug: () => {}, warn: () => {} },
  } as unknown as GatewayRequestContext;
}

export async function listModels(params: ListModelsParams) {
  const context = createModelsListTestContext(params);
  const agentId = params.agentId ?? "main";
  const config = params.cfg ?? {};
  const snapshot = { entries: params.catalog, routeVariants: params.catalog };
  if (params.routeResolverFactory) {
    mockRouteResolverFactory(params.routeResolverFactory);
  }
  return await buildModelsListResult({
    source: { kind: "gateway", context },
    agentId,
    params: {
      view: params.view ?? "all",
      ...(params.includeDefaultModels !== undefined
        ? { includeDefaultModels: params.includeDefaultModels }
        : {}),
      ...(params.refresh !== undefined ? { refresh: params.refresh } : {}),
      ...(params.preparedOnly !== undefined ? { preparedOnly: params.preparedOnly } : {}),
    },
    preloadedCatalog: params.discoveryModes ? { agentId: "main", config, snapshot } : undefined,
    catalogProjector: params.discoveryModes
      ? createModelCatalogDecisions({
          cfg: config,
          agentId,
          snapshot,
          metadataSnapshot: createPluginMetadataSnapshotFixture({
            plugins: [{ id: "test-provider", modelCatalog: { discovery: params.discoveryModes } }],
          }),
          preparedAuthStore: { version: 1, profiles: {} },
        })
      : undefined,
  });
}
