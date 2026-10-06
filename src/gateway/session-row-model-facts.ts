import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { readPreparedGatewayModelMetadata } from "./server-model-catalog-view.js";
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
  preparedAcpMeta?: SessionEntry["acp"] | null;
  /** Null records an admitted absence; only standalone readers may discover metadata. */
  preparedModelMetadata?: PluginMetadataSnapshot | null;
  source: GatewaySessionModelSource;
  rowContext: SessionListRowContext;
  modelCatalog?: SessionListModelCatalog | ModelCatalogEntry[];
  lightweightListRow?: boolean;
}) {
  const { cfg, key, agentId, source, rowContext } = params;
  const lightweight = params.lightweightListRow === true;
  const preparedCatalog =
    params.modelCatalog instanceof Map ? params.modelCatalog.get(agentId) : undefined;
  const metadataSnapshot = preparedCatalog
    ? readPreparedGatewayModelMetadata(cfg, preparedCatalog)
    : params.preparedModelMetadata;
  const selectedModel = resolveSessionSelectedModelRef({
    cfg,
    sessionKey: key,
    source,
    agentId,
    rowContext,
    allowPluginNormalization: !lightweight,
    manifestPlugins: metadataSnapshot === null ? [] : metadataSnapshot,
  });
  const { provider, model } = selectedModel;
  const rowModelIdentity = resolveSessionDisplayModelIdentityRefCached({
    cfg,
    provider,
    model,
    metadataSnapshot,
    rowContext,
  });
  // Entries and provider policy stay bound to the same prepared agent owner.
  const rowModelCatalog =
    params.modelCatalog instanceof Map ? preparedCatalog?.entries : params.modelCatalog;
  // Prepared and lightweight projections never discover missing provider policy.
  const thinkingProjection = resolveGatewaySessionThinkingProjectionInternal({
    cfg,
    agentId,
    provider,
    model,
    sessionKey: key,
    entry: params.entry,
    preparedAcpMeta: params.preparedAcpMeta,
    modelCatalog:
      rowModelCatalog ?? (lightweight || metadataSnapshot !== undefined ? [] : undefined),
    modelCatalogRouteVariants: preparedCatalog?.routeVariants,
    metadataSnapshot,
    rowContext,
    providerPolicySource:
      preparedCatalog?.pluginRegistry ??
      (lightweight || metadataSnapshot !== undefined ? "active" : undefined),
  });
  return {
    selectedModel,
    rowModelIdentity,
    thinkingProjection,
    catalogEntry:
      rowModelCatalog && provider && model ? thinkingProjection.catalogEntry : undefined,
  };
}
