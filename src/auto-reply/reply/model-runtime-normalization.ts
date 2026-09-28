/** Prepared plugin metadata handoff for runtime model normalization. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core";
import { normalizeOptionalAgentRuntimeId } from "../../agents/agent-runtime-id.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import {
  findNormalizedProviderKey,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
} from "../../agents/model-selection.js";
import { RUNTIME_MODEL_VISIBILITY_NORMALIZATION } from "../../agents/model-visibility-policy.js";
import {
  needsThinkHydration,
  resolveEffectiveAgentRuntime,
} from "../../agents/thinking-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestMetadataSnapshot,
} from "../../plugins/manifest-contract-eligibility.js";
import {
  applyModelRuntimeDirective,
  resolveModelRuntimeDirective,
} from "./directive-handling.model-runtime.js";

export function normalizeRuntimeChoiceId(runtime: string | undefined): string {
  const normalized = normalizeLowercaseStringOrEmpty(runtime);
  if (!normalized || normalized === "auto" || normalized === "default") {
    return "openclaw";
  }
  return normalized;
}

export type RuntimeModelNormalization = NonNullable<Parameters<typeof normalizeModelRef>[2]>;

/** Carries the Gateway-owned metadata snapshot through one model-selection run. */
export function resolveRuntimeNormalization(cfg: OpenClawConfig): RuntimeModelNormalization {
  return {
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    manifestPlugins: getCurrentPluginMetadataSnapshot({
      config: cfg,
      allowWorkspaceScopedSnapshot: true,
    }),
  };
}

export function findSelectedCatalogEntry(params: {
  catalog?: readonly ModelCatalogEntry[];
  provider: string;
  model: string;
}): ModelCatalogEntry | undefined {
  const normalizedProvider = normalizeProviderId(params.provider);
  const selectedKey = modelKey(normalizedProvider, params.model);
  // Literal IDs can share a display key; prefer the selected row before alias matching.
  return (
    params.catalog?.find(
      (entry) =>
        normalizeProviderId(entry.provider) === normalizedProvider &&
        entry.id.trim() === params.model.trim(),
    ) ?? params.catalog?.find((entry) => modelKey(entry.provider, entry.id) === selectedKey)
  );
}

/** Provider identity comes from authored routes or prepared/plugin metadata, not model inventory. */
export function isKnownModelSelectionProvider(params: {
  cfg: OpenClawConfig;
  provider: string;
  catalog: readonly ModelCatalogEntry[];
}): boolean {
  const provider = normalizeProviderId(params.provider);
  if (
    findNormalizedProviderKey(params.cfg.models?.providers, provider) ||
    params.catalog.some((entry) => normalizeProviderId(entry.provider) === provider)
  ) {
    return true;
  }
  const snapshot = loadManifestMetadataSnapshot({ config: params.cfg });
  return snapshot.plugins.some(
    (plugin) =>
      plugin.providers.some((id) => normalizeProviderId(id) === provider) &&
      isManifestPluginAvailableForControlPlane({ snapshot, plugin, config: params.cfg }),
  );
}

type ModelSelectionPreparation =
  | {
      status: "ready";
      catalog: ModelCatalogEntry[];
      runtime: Exclude<ReturnType<typeof resolveModelRuntimeDirective>, { kind: "invalid" }>;
      validateRuntimeSelection?: () => string | undefined;
      harness?: AgentHarness;
    }
  | { status: "rejected"; reason: "invalid-runtime" | "unknown-provider"; message: string };

/** Prepare runtime and capabilities for the selected route before any session mutation. */
export async function prepareModelSelectionRuntime(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir?: string;
  provider: string;
  model: string;
  catalog: readonly ModelCatalogEntry[];
  rawRuntime?: string;
  profileOverride?: string;
  sessionEntry?: Pick<
    SessionEntry,
    | "agentRuntimeOverride"
    | "authProfileOverride"
    | "authProfileOverrideSource"
    | "modelProvider"
    | "providerOverride"
  >;
}): Promise<ModelSelectionPreparation> {
  const sessionEntry = params.profileOverride
    ? {
        ...params.sessionEntry,
        providerOverride: params.provider,
        modelProvider: params.provider,
        authProfileOverride: params.profileOverride,
        authProfileOverrideSource: "user" as const,
      }
    : params.sessionEntry;
  let runtime = resolveModelRuntimeDirective(params);
  if (runtime.kind === "invalid") {
    return { status: "rejected", reason: "invalid-runtime", message: runtime.errorText };
  }
  const selected = findSelectedCatalogEntry(params);
  if (!isKnownModelSelectionProvider(params)) {
    return {
      status: "rejected",
      reason: "unknown-provider",
      message: `Unknown provider "${params.provider}". Use /models to list providers.`,
    };
  }
  let validateRuntimeSelection: (() => string | undefined) | undefined;
  let harness: AgentHarness | undefined;
  let inheritedCliRuntime: string | undefined;
  let needsRuntimeChoice = runtime.kind === "set";
  if (!params.rawRuntime) {
    const runtimeFacts = {
      agentId: params.agentId,
      provider: params.provider,
      modelId: params.model,
      modelApi: selected?.api,
      modelBaseUrl: selected?.baseUrl,
    };
    const policy = resolveAgentHarnessPolicy({ ...runtimeFacts, config: params.cfg });
    const effectiveRuntime = resolveEffectiveAgentRuntime({
      ...runtimeFacts,
      cfg: params.cfg,
      sessionEntry,
    });
    if (runtime.kind === "clear" || !sessionEntry?.agentRuntimeOverride) {
      inheritedCliRuntime = resolveCliRuntimeExecutionProvider({
        cfg: params.cfg,
        agentId: params.agentId,
        provider: params.provider,
        modelId: params.model,
        authProfileId: sessionEntry?.authProfileOverride,
      });
    }
    needsRuntimeChoice = Boolean(
      selected?.nativeRuntime ||
      effectiveRuntime !== "openclaw" ||
      inheritedCliRuntime ||
      (policy.forcedByEnvironment && policy.runtime !== "openclaw"),
    );
  }
  if (needsRuntimeChoice) {
    const { preparePublishedModelRuntimeChoice } =
      await import("../../agents/model-runtime-choice.js");
    const choice = await preparePublishedModelRuntimeChoice({
      ...params,
      sessionEntry,
      runtimeId: runtime.kind === "set" ? runtime.runtime : undefined,
      preferredRuntimeId:
        (runtime.kind === "unchanged"
          ? normalizeOptionalAgentRuntimeId(sessionEntry?.agentRuntimeOverride)
          : undefined) ?? inheritedCliRuntime,
    });
    if (choice.kind === "unavailable") {
      return { status: "rejected", reason: "invalid-runtime", message: choice.message };
    }
    validateRuntimeSelection = choice.validate;
    harness = choice.harness;
    runtime = { kind: "set", runtime: choice.runtimeId };
  }
  const runtimeEntry = { ...sessionEntry };
  applyModelRuntimeDirective(runtimeEntry, runtime);
  const agentRuntime =
    runtime.kind === "set"
      ? runtime.runtime
      : resolveEffectiveAgentRuntime({
          cfg: params.cfg,
          agentId: params.agentId,
          provider: params.provider,
          modelId: params.model,
          modelApi: selected?.api,
          modelBaseUrl: selected?.baseUrl,
          sessionEntry: runtimeEntry,
        });
  if (!needsThinkHydration(params.catalog, params.provider, params.model, agentRuntime)) {
    return {
      status: "ready",
      runtime,
      catalog: [...params.catalog],
      validateRuntimeSelection,
      harness,
    };
  }
  // The selected route owns its capabilities. A prepared default-provider row cannot
  // supply thinking or context metadata for an explicit cross-provider selection.
  const { loadProviderScopedThinkingCatalog } =
    await import("../../agents/model-catalog.runtime.js");
  const catalog = await loadProviderScopedThinkingCatalog({
    config: params.cfg,
    agentId: params.agentId,
    provider: params.provider,
    model: params.model,
    agentRuntime,
    workspaceDir: params.workspaceDir,
  });
  const resolved = findSelectedCatalogEntry({ ...params, catalog });
  return {
    status: "ready",
    runtime,
    validateRuntimeSelection,
    harness,
    catalog: resolved
      ? [resolved, ...params.catalog.filter((entry) => entry !== selected)]
      : [...params.catalog],
  };
}

// Match catalog metadata by literal identity, not a potentially collapsed display key.
function modelCatalogEntryKey(entry: Pick<ModelCatalogEntry, "provider" | "id">): string {
  return JSON.stringify([entry.provider.trim(), entry.id.trim()]);
}

/** Retain prepared-only models while overlaying matching configured model metadata. */
export function mergePreparedConfiguredCatalog(params: {
  configured: ModelCatalogEntry[];
  prepared?: readonly ModelCatalogEntry[];
}): ModelCatalogEntry[] {
  if (!params.prepared?.length) {
    return params.configured;
  }
  const mergedByKey = new Map(
    params.configured.map((entry) => [modelCatalogEntryKey(entry), entry]),
  );
  // Plugin-owned providers need not have authored models.providers rows. Keep
  // their prepared capabilities too; selection applies visibility after this merge.
  for (const entry of params.prepared) {
    const key = modelCatalogEntryKey(entry);
    mergedByKey.set(key, { ...mergedByKey.get(key), ...entry });
  }
  return [...mergedByKey.values()];
}
