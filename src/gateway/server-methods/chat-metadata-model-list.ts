import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import { resolveAdditionalConfiguredModelRefs } from "../../agents/model-visibility-policy.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../../agents/prepared-model-runtime-auth.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { CurrentReadAuthority } from "../../shared/current-read-authority.js";
import { captureOpenClawStateReadContext } from "../../state/openclaw-state-worker-context.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { listUserProfileAuthLinksAsync } from "../../state/user-model-accounts.js";
import { captureUserProfileModelAccountLinksAuthority } from "../../state/user-profile-events.js";
import type { PreparedGenerationFacts } from "./chat-metadata-facts.js";
import type {
  GatewayModelCatalogContext,
  PreparedModelsListRequest,
} from "./models-list-context.js";
import type { prepareModelsListResult } from "./models-list-result.js";

type SharedModelsListRequest = Omit<
  PreparedModelsListRequest,
  "requesterProfileId" | "readScope"
> & {
  readScope?: Pick<
    NonNullable<PreparedModelsListRequest["readScope"]>,
    "agentId" | "sessionKey" | "sessionEntry"
  >;
};
type PreparedModels = Awaited<ReturnType<typeof prepareModelsListResult>>;

type ProviderIdentitySource = {
  config: OpenClawConfig;
  agentId: string;
  authStore: AuthProfileStore;
  providerPlugins: ReadonlyMap<string, readonly string[]>;
};

/** Everything a provider's rows depend on that a user action can remove: config, auth, plugins. */
function providerIdentity(source: ProviderIdentitySource, provider: string): unknown {
  const { config, authStore } = source;
  const pluginIds = source.providerPlugins.get(provider) ?? [];
  const forProvider = <T>(entries: Record<string, T> | undefined) =>
    Object.entries(entries ?? {}).filter(([id]) => normalizeProviderId(id) === provider);
  // A ref without a provider prefix may resolve to any provider.
  const namesProvider = (ref: string) =>
    !ref.includes("/") || normalizeProviderId(ref.slice(0, ref.indexOf("/"))) === provider;
  const modelSettings = (models: Record<string, unknown> | undefined) =>
    Object.entries(models ?? {}).filter(([ref]) => namesProvider(ref));
  const { providers: _providers, ...models } = config.models ?? {};
  return {
    models,
    // Config env may hold any provider's key; an edit hides every provider until republication.
    env: config.env,
    provider: forProvider(config.models?.providers),
    authProfiles: Object.entries(config.auth?.profiles ?? {}).filter(
      ([, profile]) => normalizeProviderId(profile.provider) === provider,
    ),
    authOrder: forProvider(config.auth?.order),
    credentials: Object.entries(authStore.profiles).filter(
      ([, profile]) => normalizeProviderId(profile.provider) === provider,
    ),
    credentialOrder: forProvider(authStore.order),
    // The configured view admits exactly these refs (primary, fallbacks, model maps, utility).
    configuredRefs: resolveAdditionalConfiguredModelRefs({
      cfg: config,
      agentId: source.agentId,
    }).filter(namesProvider),
    modelSettings: [
      modelSettings(config.agents?.defaults?.models),
      modelSettings(config.agents?.entries?.[source.agentId]?.models),
    ],
    // Selection policy may name any provider's models, including by pattern.
    modelPolicy: [
      config.agents?.defaults?.modelPolicy,
      config.agents?.entries?.[source.agentId]?.modelPolicy,
    ],
    plugins: {
      enabled: config.plugins?.enabled,
      allow: config.plugins?.allow?.filter((id) => pluginIds.includes(id)),
      deny: config.plugins?.deny?.filter((id) => pluginIds.includes(id)),
      entries: pluginIds.map((id) => config.plugins?.entries?.[id]),
    },
  };
}

/**
 * Serves a published list while its owner rebuilds. A provider whose config, credentials,
 * visibility or plugin changed since publication is removed now and returns with the new
 * catalog; unchanged providers keep their rows.
 */
export function retainPublishedModelsList(
  published: ModelsListResult,
  previous: ProviderIdentitySource,
  current: Omit<ProviderIdentitySource, "providerPlugins">,
): ModelsListResult {
  const kept = new Map<string, boolean>();
  const keep = (provider: string) => {
    const id = normalizeProviderId(provider);
    let result = kept.get(id);
    if (result === undefined) {
      result = isDeepStrictEqual(
        providerIdentity(previous, id),
        providerIdentity({ ...current, providerPlugins: previous.providerPlugins }, id),
      );
      kept.set(id, result);
    }
    return result;
  };
  const { models, decisionModels, providerOutcomes, pendingProviders, ...rest } = published;
  return {
    ...rest,
    models: models.filter((model) => keep(model.provider)),
    ...(decisionModels && {
      decisionModels: decisionModels.filter((model) => keep(model.provider)),
    }),
    ...(providerOutcomes && {
      providerOutcomes: providerOutcomes.filter((outcome) => keep(outcome.provider)),
    }),
    ...(pendingProviders && { pendingProviders: pendingProviders.filter(keep) }),
  };
}

/** Model-list variants are derived facts of the existing chat metadata generation. */
export function createChatMetadataModelList(params: {
  facts: PreparedGenerationFacts;
  context: GatewayModelCatalogContext;
  maxEntries: number;
}) {
  const agents = new Map(params.facts.agents.map((agent) => [agent.agentId, agent]));
  const projections = new Map<string, Promise<PreparedModels>>();
  const prepare = async (
    request: SharedModelsListRequest,
    authority?: CurrentReadAuthority,
  ): Promise<PreparedModels> => {
    const key = JSON.stringify([
      request.agentId,
      { ...request.params, sessionKey: Boolean(request.params.sessionKey) },
      request.includeManualSelection,
      request.readScope?.sessionEntry,
    ]);
    const existing = projections.get(key);
    if (existing) {
      const projection = await existing;
      if (projection.isCurrent()) {
        return projection;
      }
      projections.delete(key);
    }
    const facts = agents.get(request.agentId);
    if (!facts?.owner.catalogOwner || !facts.owner.isCurrent()) {
      throw new PreparedModelRuntimePublicationSupersededError(
        "Model catalog changed while preparing this result. Retry the request.",
      );
    }
    const { owner, modelCatalog, authStore, authModes } = facts;
    const catalogOwner = facts.owner.catalogOwner;
    const pending = import("./models-list-result.js").then(({ prepareModelsListResult }) =>
      prepareModelsListResult({
        ...request,
        preparationAuthority: authority,
        source: {
          kind: "published",
          getConfig: params.context.getRuntimeConfig,
          owner: {
            ...owner,
            catalogOwner,
            agentId: request.agentId,
            workspaceDir: catalogOwner.workspaceDir,
            modelCatalog,
            authStore,
            authModes,
            authMaterializations: getPreparedModelRuntimeAuthMaterializations(owner),
          },
        },
        preloadedOnly: true,
      }),
    );
    projections.set(key, pending);
    pruneMapToMaxSize(projections, params.maxEntries);
    void pending.catch(() => {
      projections.delete(key);
    });
    return pending;
  };
  return {
    async read(request: PreparedModelsListRequest): Promise<PreparedModels | undefined> {
      const { requesterProfileId, readScope, ...shared } = request;
      if (readScope) {
        const entry = readScope.sessionEntry;
        if (
          !readScope.sessionKey ||
          isUserModelAuthProfileId(entry?.authProfileOverride?.trim() ?? "")
        ) {
          return undefined;
        }
        // Retain selection facts, never the saved row, request authority, or private account.
        return prepare(
          {
            ...shared,
            readScope: {
              agentId: request.agentId,
              sessionKey: readScope.sessionKey,
              sessionEntry: entry && {
                modelOverride: entry.modelOverride,
                providerOverride: entry.providerOverride,
                modelOverrideRouteResolution: entry.modelOverrideRouteResolution,
                modelOverrideFallbackOriginProvider: entry.modelOverrideFallbackOriginProvider,
                modelOverrideFallbackOriginModel: entry.modelOverrideFallbackOriginModel,
                agentRuntimeOverride: entry.agentRuntimeOverride,
                authProfileOverride: entry.authProfileOverride,
                authProfileOverrideSource: entry.authProfileOverrideSource,
                authProfileOverrideCompactionCount: entry.authProfileOverrideCompactionCount,
              },
            },
          },
          readScope,
        );
      }
      if (requesterProfileId && request.params.view !== "provider-config") {
        const authority = captureUserProfileModelAccountLinksAuthority(
          captureOpenClawStateReadContext().admission,
          requesterProfileId,
        );
        // Personal-account links are read under the requesting human's authority.
        const links = await listUserProfileAuthLinksAsync(requesterProfileId);
        if (!authority()) {
          return { isCurrent: () => false, read: () => ({ models: [] }) };
        }
        // Private account credentials and discovery stay within the requesting human's authority.
        if (links.length > 0) {
          return undefined;
        }
        const projection = await prepare(shared);
        return {
          isCurrent: () => authority() && projection.isCurrent(),
          read: (): ModelsListResult => ({
            ...projection.read(),
            accountSelection: { kind: "automatic", label: "Automatic account selection" },
          }),
        };
      }
      return prepare(shared);
    },
  };
}
