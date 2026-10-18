import type { ModelsListParams } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { resolveAgentWorkspaceDir, resolveAmbientOwnerAgentId } from "../../agents/agent-scope.js";
import type { createModelCatalogDecisions } from "../../agents/model-catalog-decisions.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { createOpenAIModelRoutesResolver } from "../../agents/openai-model-routes.js";
import { publishedModelCatalogOwnerMatchesAgent } from "../../agents/prepared-model-catalog-owner.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "../../agents/prepared-model-runtime.errors.js";
import { preparedModelRuntimeConfigsMatch } from "../../agents/prepared-model-runtime.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { getRuntimeConfig } from "../../config/config.js";
import { captureRuntimeConfig } from "../../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  withCurrentReadAuthority,
  type CurrentReadAuthority,
} from "../../shared/current-read-authority.js";
import { loadDeferredCatalog, readPreparedCatalog } from "../server-model-catalog-auth.js";
import type { ChatMetadataReadParams, ChatMetadataSessionEntry } from "./chat-metadata-contract.js";
import { resolveSessionCatalogProfiles } from "./chat-metadata-session-projection.js";
import type { ModelsListCatalogSource } from "./models-list-context.js";

export type BuildModelsListResultParams = {
  source: ModelsListCatalogSource;
  agentId?: string;
  requesterProfileId?: string;
  readScope?: ChatMetadataReadParams;
  /** Request authority does not imply a session/account-selection projection. */
  publicationScope?: Pick<
    ChatMetadataReadParams,
    "isCurrent" | "assertCurrent" | "withCurrent" | "beforeRequest"
  >;
  preparationAuthority?: CurrentReadAuthority;
  params: ModelsListParams;
  includeManualSelection?: boolean;
  preloadedCatalog?: {
    agentId: string;
    config: OpenClawConfig;
    snapshot: ModelCatalogSnapshot;
  };
  catalogProjector?: ReturnType<typeof createModelCatalogDecisions>;
  preloadedOnly?: boolean;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
};

export type ModelsListOwner = NonNullable<Awaited<ReturnType<typeof resolveModelsListOwner>>>;

export async function resolveModelsListOwner({
  preparationAuthority,
  ...params
}: BuildModelsListResultParams) {
  const { source } = params;
  const scope = params.readScope;
  const publicationScope = params.publicationScope ?? scope;
  const draft = scope?.draftAccountSelection;
  const authority =
    preparationAuthority ??
    (draft
      ? {
          withCurrent: publicationScope?.withCurrent,
          assertCurrent: () => {
            draft.assertCurrent();
            publicationScope?.assertCurrent?.();
          },
        }
      : publicationScope);
  const sessionEntry: ChatMetadataSessionEntry | undefined = draft
    ? { authProfileOverride: draft.authProfileId, authProfileOverrideSource: "user" }
    : scope?.sessionEntry;
  const useRequesterDefaults = !scope?.sessionKey && !scope?.sessionEntry;
  draft?.assertCurrent();
  const currentConfig =
    source.kind === "gateway"
      ? source.context.getRuntimeConfig
      : (source.getConfig ?? getRuntimeConfig);
  const publishedOwner = source.kind === "published" ? source.owner : undefined;
  const requestConfig = currentConfig();
  const initialConfig = publishedOwner?.config ?? requestConfig;
  const initialAgentId = resolveAmbientOwnerAgentId(initialConfig, params.agentId);
  const profiles = resolveSessionCatalogProfiles(sessionEntry, initialConfig, initialAgentId);
  const view = params.params.view ?? "default";
  const refresh = params.params.refresh === true;
  const preloadedCatalog =
    params.preloadedCatalog?.agentId === initialAgentId &&
    preparedModelRuntimeConfigsMatch(params.preloadedCatalog.config, initialConfig)
      ? params.preloadedCatalog
      : undefined;
  // A preloaded projection carries the same owner facts used by session metadata.
  const usedPreloadedCatalog =
    preloadedCatalog !== undefined && params.catalogProjector !== undefined;
  if (source.kind === "gateway" && refresh && !params.preloadedOnly) {
    await loadDeferredCatalog(source.context, initialAgentId, {
      readOnly: false,
      refreshFullCatalog: true,
      ...(params.params.provider ? { providerDiscoveryProviderIds: [params.params.provider] } : {}),
    });
    await withCurrentReadAuthority(authority, () => {});
  }
  const ownerSnapshot =
    source.kind === "gateway" && !usedPreloadedCatalog
      ? await readPreparedCatalog(source.context, initialAgentId)
      : undefined;
  await withCurrentReadAuthority(authority, () => {});
  if (!publishedOwner && !usedPreloadedCatalog && !ownerSnapshot) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      "Model catalog is not ready. Retry after Gateway startup or refresh finishes.",
    );
  }
  if (
    ownerSnapshot &&
    params.agentId !== undefined &&
    !publishedModelCatalogOwnerMatchesAgent(ownerSnapshot, initialAgentId)
  ) {
    return undefined;
  }
  const snapshot =
    publishedOwner?.modelCatalog ??
    (usedPreloadedCatalog ? preloadedCatalog.snapshot : ownerSnapshot);
  if (!snapshot) {
    throw new Error("Model catalog omitted its published snapshot");
  }
  const sourceOwner = publishedOwner ?? ownerSnapshot;
  // Routing consumes one runtime/source pair instead of reprojecting it for every model.
  const cfg = captureRuntimeConfig(sourceOwner?.config ?? initialConfig);
  const agentId = sourceOwner?.agentId ?? initialAgentId;
  const workspaceDir =
    sourceOwner?.workspaceDir ??
    resolveAgentWorkspaceDir(cfg, agentId) ??
    resolveDefaultAgentWorkspaceDir();
  const preparedProjectionOwner = sourceOwner ?? params.catalogProjector;
  const metadataSnapshot = preparedProjectionOwner?.metadataSnapshot;
  const preparedAuthStore = preparedProjectionOwner?.authStore;
  const preparedPluginRegistry = preparedProjectionOwner?.pluginRegistry;
  return {
    params,
    scope,
    publicationScope,
    draft,
    authority,
    sessionEntry,
    useRequesterDefaults,
    currentConfig,
    publishedOwner,
    requestConfig,
    profiles,
    view,
    refresh,
    usedPreloadedCatalog,
    ownerSnapshot,
    snapshot,
    sourceOwner,
    cfg,
    agentId,
    workspaceDir,
    preparedProjectionOwner,
    metadataSnapshot,
    preparedAuthStore,
    preparedPluginRegistry,
  };
}
