import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readPreparedGatewayModelCatalogMetadata } from "./server-model-catalog-view.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import type {
  GatewaySessionModelSource,
  SessionListRowContext,
} from "./session-utils-contracts.js";
import { resolveSessionSelectedModelRef } from "./session-utils-model-selection.js";
import {
  resolveGatewaySessionThinkingProjectionInternal,
  resolveSessionDisplayModelIdentityRefCached,
} from "./session-utils-model.js";
import type { SessionListModelCatalog } from "./session-utils.types.js";

/** Search and row presentation share model policy without preparing unrelated row fields. */
export function readSessionRowModelFacts(params: {
  cfg: OpenClawConfig;
  key: string;
  agentId: string;
  entry?: SessionEntry;
  source: GatewaySessionModelSource;
  rowContext: SessionListRowContext;
  modelCatalog?: SessionListModelCatalog | ModelCatalogEntry[];
  lightweightListRow?: boolean;
}) {
  const { cfg, key, agentId, source, rowContext } = params;
  const lightweight = params.lightweightListRow === true;
  const preparedCatalog =
    params.modelCatalog instanceof Map ? params.modelCatalog.get(agentId) : undefined;
  const metadataSnapshot = readPreparedGatewayModelCatalogMetadata(preparedCatalog);
  const selectedModel = resolveSessionSelectedModelRef({
    cfg,
    sessionKey: key,
    source,
    agentId,
    rowContext,
    allowPluginNormalization: !lightweight,
    manifestPlugins: metadataSnapshot,
  });
  const { provider, model } = selectedModel;
  const rowModelIdentity = resolveSessionDisplayModelIdentityRefCached({
    cfg,
    provider,
    model,
    rowContext,
  });
  // Entries and provider policy stay bound to the same prepared agent owner.
  const rowModelCatalog =
    params.modelCatalog instanceof Map ? preparedCatalog?.entries : params.modelCatalog;
  // Lightweight projections must not rediscover plugin-backed configured catalog metadata.
  const thinkingProjection = resolveGatewaySessionThinkingProjectionInternal({
    cfg,
    agentId,
    provider: provider ?? DEFAULT_PROVIDER,
    model: model ?? DEFAULT_MODEL,
    sessionKey: resolveStoredSessionKeyForAgentStore({ cfg, agentId, sessionKey: key }),
    entry: params.entry,
    modelCatalog: rowModelCatalog ?? (lightweight ? [] : undefined),
    modelCatalogRouteVariants: preparedCatalog?.routeVariants,
    metadataSnapshot,
    rowContext,
    providerPolicySource: preparedCatalog?.pluginRegistry ?? (lightweight ? "active" : undefined),
  });
  return {
    selectedModel,
    rowModelIdentity,
    thinkingProjection,
    catalogEntry:
      rowModelCatalog && provider && model ? thinkingProjection.catalogEntry : undefined,
  };
}
