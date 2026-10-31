import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { listRegisteredAgentHarnesses } from "../agents/harness/registry.js";
import type { AgentHarnessSessionRuntimeOwnership } from "../agents/harness/types.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { normalizeStoredOverrideModel } from "../agents/model-selection-persisted.js";
import { parseModelRef } from "../agents/model-selection.js";
import { resolveSessionConfiguredDefault } from "../agents/session-model-ref.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveSessionModelOverrideRouteResolution } from "../config/sessions/model-override-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { formatAgentRuntimeLabel } from "../shared/agent-runtime-display.js";
import { readPreparedGatewayModelMetadata } from "./server-model-catalog-view.js";
import { addSessionListSearchModelFields } from "./session-list-search-fields.js";
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

/** A conservative vocabulary of admitted identities; never reconstruct thinking facts to reject a query. */
export function prepareSessionRowModelSearch(
  params: Pick<
    Parameters<typeof readSessionRowModelFacts>[0],
    "cfg" | "modelCatalog" | "rowContext"
  > & {
    rows: Iterable<
      Pick<
        Parameters<typeof readSessionRowModelFacts>[0],
        "agentId" | "entry" | "preparedAcpMeta" | "preparedRuntimeOwnership"
      > & {
        storedEntry?: SessionEntry;
        materialized?: {
          source: Pick<
            ReturnType<typeof readSessionRowModelFacts>,
            "selectedModel" | "rowModelIdentity"
          > & {
            thinkingProjection: Pick<
              ReturnType<typeof readSessionRowModelFacts>["thinkingProjection"],
              "agentRuntime"
            >;
          };
        };
      }
    >;
  },
): (search: string) => boolean {
  const fields = new Set<string>(["openclaw", "codex", "auto", "acpx", "-"]);
  const providers = new Set<string>();
  const models = new Set<string>();
  const refs = new Map<string, Set<string>>();
  const bare = new Set<string>();
  const runtimes = new Set<string>();
  const agents = new Set(Object.keys(params.cfg.agents?.entries ?? {}));
  const defaults = new Set([DEFAULT_PROVIDER]);
  const metadata = new Set<PluginMetadataSnapshot | null>([
    readPreparedGatewayModelMetadata(params.cfg),
  ]);
  const lowercaseFields = new Map<string, string>();
  const lower = (value: string) => {
    let text = lowercaseFields.get(value);
    if (text === undefined) {
      text = normalizeLowercaseStringOrEmpty(value);
      lowercaseFields.set(value, text);
    }
    return text;
  };
  const add = (value?: string) => {
    if (value) {
      fields.add(lower(value));
    }
  };
  const runtime = (value?: string) => {
    if (!value || runtimes.has(value)) {
      return;
    }
    runtimes.add(value);
    add(value);
    add(normalizeOptionalAgentRuntimeId(value));
  };
  const ref = (provider?: string, model?: string) => {
    if (provider) {
      providers.add(lower(provider));
    }
    if (!model) {
      return;
    }
    models.add(lower(model));
    if (provider) {
      let providerModels = refs.get(provider);
      if (!providerModels) {
        refs.set(provider, (providerModels = new Set()));
      }
      providerModels.add(model);
    } else {
      bare.add(model);
    }
  };
  function* identities() {
    for (const [provider, providerModels] of refs) {
      for (const model of providerModels) {
        yield { provider, model };
      }
    }
  }
  const entry = (value: SessionEntry | undefined) => {
    ref(value?.modelProvider, value?.model);
    ref(value?.providerOverride, value?.modelOverride);
    if (value?.providerOverride && value.modelOverride) {
      const override = normalizeStoredOverrideModel({
        providerOverride: value.providerOverride,
        modelOverride: value.modelOverride,
        routeResolution: resolveSessionModelOverrideRouteResolution(value),
      });
      ref(override.providerOverride, override.modelOverride);
    }
    runtime(value?.agentRuntimeOverride);
    runtime(value?.agentHarnessId);
  };
  const catalogModel = (model: ModelCatalogEntry) => {
    ref(model.provider, model.id);
    add(model.alias);
    runtime(model.nativeRuntime);
  };
  for (const row of params.rows) {
    agents.add(row.agentId);
    entry(row.storedEntry);
    if (row.entry !== row.storedEntry) {
      entry(row.entry);
    }
    ref(
      row.preparedRuntimeOwnership?.modelRef?.provider,
      row.preparedRuntimeOwnership?.modelRef?.model,
    );
    runtime(row.preparedAcpMeta?.backend);
    const source = row.materialized?.source;
    ref(source?.selectedModel.provider, source?.selectedModel.model);
    ref(source?.rowModelIdentity.provider, source?.rowModelIdentity.model);
    if (source) {
      runtime(source.thinkingProjection.agentRuntime.id);
      add(formatAgentRuntimeLabel(source.thinkingProjection.agentRuntime));
    }
  }
  for (const agentId of agents) {
    const catalog =
      params.modelCatalog instanceof Map ? params.modelCatalog.get(agentId) : undefined;
    const snapshot = readPreparedGatewayModelMetadata(params.cfg, catalog);
    metadata.add(snapshot);
    for (const allowPluginNormalization of [false, true]) {
      const selected = resolveSessionConfiguredDefault(params.cfg, agentId, {
        allowPluginNormalization,
        manifestPlugins: snapshot ?? [],
        configuredDefaultModelByAgent: params.rowContext.configuredDefaultModelByAgent,
      });
      defaults.add(selected.provider);
      ref(selected.provider, selected.model);
    }
    for (const [id, model] of Object.entries(params.cfg.agents?.entries?.[agentId]?.models ?? {})) {
      ref(undefined, id);
      add(model.alias);
      runtime(model.agentRuntime?.id);
    }
    for (const model of [...(catalog?.entries ?? []), ...(catalog?.routeVariants ?? [])]) {
      catalogModel(model);
    }
  }
  for (const [id, model] of Object.entries(params.cfg.agents?.defaults?.models ?? {})) {
    ref(undefined, id);
    add(model.alias);
    runtime(model.agentRuntime?.id);
  }
  for (const [provider, config] of Object.entries(params.cfg.models?.providers ?? {})) {
    runtime(config.agentRuntime?.id);
    for (const model of config.models) {
      ref(provider, model.id);
      runtime(model.agentRuntime?.id);
    }
  }
  if (Array.isArray(params.modelCatalog)) {
    for (const model of params.modelCatalog) {
      catalogModel(model);
    }
  }
  for (const runs of [
    params.rowContext.subagentRuns.inputs.runs.values(),
    params.rowContext.subagentRuns.inputs.inMemoryRuns,
  ]) {
    for (const run of runs) {
      ref(undefined, run.model);
    }
  }
  for (const snapshot of metadata) {
    for (const plugin of snapshot?.plugins ?? []) {
      for (const id of [...plugin.cliBackends, ...(plugin.setup?.cliBackends ?? [])]) {
        runtime(id);
      }
    }
    const inputs = [
      ...[...identities()].map(({ provider, model }) => ({
        raw: `${provider}/${model}`,
        provider,
      })),
      ...[...bare].flatMap((model) => [...defaults].map((provider) => ({ raw: model, provider }))),
    ];
    // Prepared provider hooks can define aliases absent from catalogs; normalize distinct inputs once.
    for (const input of inputs) {
      for (const allowPluginNormalization of [false, true]) {
        const normalized = parseModelRef(input.raw, input.provider, {
          allowPluginNormalization,
          manifestPlugins: snapshot ?? [],
        });
        ref(normalized?.provider, normalized?.model);
      }
    }
    // Snapshot before adding normalized display refs.
    const displayIdentities = [...identities()];
    for (const identity of displayIdentities) {
      const display = resolveSessionDisplayModelIdentityRefCached({
        cfg: params.cfg,
        ...identity,
        metadataSnapshot: snapshot,
      });
      ref(display.provider, display.model);
    }
  }
  const modelFields: Array<string | undefined> = [];
  for (const identity of identities()) {
    addSessionListSearchModelFields(modelFields, identity);
  }
  for (const provider of providers) {
    addSessionListSearchModelFields(modelFields, { provider });
  }
  for (const model of models) {
    addSessionListSearchModelFields(modelFields, { model });
  }
  for (const field of modelFields) {
    add(field);
  }
  return (search) => {
    for (const field of fields) {
      if (field.includes(search)) {
        return true;
      }
    }
    // Direct runtime registration is live within a retained registry generation.
    const matchesRuntime = (id: string) =>
      normalizeLowercaseStringOrEmpty(id).includes(search) ||
      normalizeLowercaseStringOrEmpty(normalizeOptionalAgentRuntimeId(id)).includes(search);
    if (
      resolveRuntimeCliBackends("metadata").some((backend) => matchesRuntime(backend.id)) ||
      listRegisteredAgentHarnesses().some(({ harness }) => matchesRuntime(harness.id))
    ) {
      return true;
    }
    // Bare historical models can infer a provider; rejection covers every possible pairing.
    if (search.includes("/")) {
      for (const provider of providers) {
        for (const model of models) {
          if (`${provider}/${model}`.includes(search)) {
            return true;
          }
        }
      }
    }
    return false;
  };
}

/** Search and row presentation share model policy without preparing unrelated row fields. */
export function readSessionRowModelFacts(params: {
  cfg: OpenClawConfig;
  key: string;
  agentId: string;
  entry?: SessionEntry;
  preparedAcpMeta?: SessionEntry["acp"] | null;
  preparedRuntimeOwnership?: AgentHarnessSessionRuntimeOwnership | null;
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
    preparedRuntimeOwnership: params.preparedRuntimeOwnership,
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
      rowModelCatalog && provider && model ? thinkingProjection.capacityCatalogEntry : undefined,
  };
}
