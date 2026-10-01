import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../../agents/prepared-model-runtime-auth.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { captureOpenClawStateReadContext } from "../../state/openclaw-state-worker-context.js";
import { listUserProfileAuthLinksAsync } from "../../state/user-model-accounts.js";
import { captureUserProfileModelAccountLinksAuthority } from "../../state/user-profile-events.js";
import type { PreparedGenerationFacts } from "./chat-metadata-facts.js";
import type {
  GatewayModelCatalogContext,
  PreparedModelsListRequest,
} from "./models-list-context.js";
import type { prepareModelsListResult } from "./models-list-result.js";

type SharedModelsListRequest = Omit<PreparedModelsListRequest, "requesterProfileId">;
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
  const prepare = (request: SharedModelsListRequest): Promise<PreparedModels> => {
    const key = JSON.stringify([request.agentId, request.params, request.includeManualSelection]);
    const existing = projections.get(key);
    if (existing) {
      return existing.then((projection) => {
        if (projection.isCurrent()) {
          return projection;
        }
        if (projections.get(key) === existing) {
          projections.delete(key);
        }
        return prepare(request);
      });
    }
    const facts = agents.get(request.agentId);
    if (!facts?.owner.catalogOwner || !facts.owner.isCurrent()) {
      return Promise.reject(
        new PreparedModelRuntimePublicationSupersededError(
          "Model catalog changed while preparing this result. Retry the request.",
        ),
      );
    }
    const { owner, modelCatalog, authStore, authModes } = facts;
    const catalogOwner = facts.owner.catalogOwner;
    const pending = import("./models-list-result.js")
      .then(({ prepareModelsListResult }) =>
        prepareModelsListResult({
          ...request,
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
      if (projections.get(key) === pending) {
        projections.delete(key);
      }
    });
    return pending;
  };
  return {
    prepare,
    async read(request: PreparedModelsListRequest): Promise<PreparedModels | undefined> {
      const { requesterProfileId, ...shared } = request;
      if (requesterProfileId && request.params.view !== "provider-config") {
        const authority = captureUserProfileModelAccountLinksAuthority(
          captureOpenClawStateReadContext().admission,
          requesterProfileId,
        );
        // Foreign commits must become visible on the next unpinned read, too.
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
          read: (): ModelsListResult => {
            const { decisionModels, ...result } = projection.read();
            return {
              ...result,
              accountSelection: { kind: "automatic", label: "Automatic account selection" },
              ...(decisionModels ? { decisionModels } : {}),
            };
          },
        };
      }
      return prepare(shared);
    },
  };
}
