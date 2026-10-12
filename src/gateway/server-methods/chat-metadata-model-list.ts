import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../../agents/prepared-model-runtime-auth.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
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

/** Model-list variants are derived facts of the existing chat metadata generation. */
export function createChatMetadataModelList(params: {
  facts: PreparedGenerationFacts;
  context: GatewayModelCatalogContext;
  requested: Map<string, SharedModelsListRequest>;
  maxEntries: number;
}) {
  const agents = new Map(params.facts.agents.map((agent) => [agent.agentId, agent]));
  for (const [key, request] of params.requested) {
    if (!agents.has(request.agentId)) {
      params.requested.delete(key);
    }
  }
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
    const pending = import("./models-list-result.js")
      .then(({ prepareModelsListResult }) =>
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
      )
      .then((projection) => {
        params.requested.set(key, { ...request, params: { ...request.params } });
        pruneMapToMaxSize(params.requested, params.maxEntries);
        return projection;
      });
    projections.set(key, pending);
    pruneMapToMaxSize(projections, params.maxEntries);
    void pending.catch(() => {
      projections.delete(key);
    });
    return pending;
  };
  return {
    prepare,
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
