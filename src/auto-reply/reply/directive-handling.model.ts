// Handles model directives and persists provider/model selections.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAuthStorePathForDisplay } from "../../agents/auth-profiles.js";
import { resolveConfiguredModelEntries } from "../../agents/configured-model-entries.js";
import {
  isModelKeyAllowedBySet,
  parseConfiguredModelVisibilityEntries,
} from "../../agents/model-selection-shared.js";
import {
  type ModelAliasIndex,
  buildConfiguredModelCatalog,
  modelKey,
  normalizeProviderId,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { RUNTIME_MODEL_VISIBILITY_NORMALIZATION } from "../../agents/model-visibility-policy.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readSessionFallbackModel } from "../../status/session-fallback-model.js";
import { shortenHomePath } from "../../utils.js";
import { resolveSelectedAndActiveModel } from "../model-runtime.js";
import { resolveSupportedThinkingLevel } from "../thinking.js";
import type { ThinkingCatalogEntry } from "../thinking.shared.js";
import type { ReplyPayload } from "../types.js";
import { resolveModelsCommandReply } from "./commands-models.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import type { ThinkLevel } from "./directives.js";

type ModelPickerCatalogEntry = { provider: string; id: string; name?: string };

function pushUniqueCatalogEntry(params: {
  keys: Set<string>;
  out: ModelPickerCatalogEntry[];
  provider: string;
  id: string;
  name?: string;
  fallbackNameToId: boolean;
}) {
  const provider = normalizeProviderId(params.provider);
  const id = normalizeOptionalString(params.id) ?? "";
  if (!provider || !id) {
    return;
  }
  const key = modelKey(provider, id);
  if (params.keys.has(key)) {
    return;
  }
  params.keys.add(key);
  params.out.push({
    provider,
    id,
    name: params.fallbackNameToId ? (params.name ?? id) : params.name,
  });
}

function buildModelPickerCatalog(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultModel: string;
  effectiveDefaultRef?: { provider: string; model: string } | null;
  agentId: string;
  aliasIndex: ModelAliasIndex;
  policyAliasIndex: ModelAliasIndex;
  allowedModelKeys: ReadonlySet<string>;
  allowedModelCatalog: Array<{ provider: string; id?: string; name?: string }>;
}): ModelPickerCatalogEntry[] {
  const configuredProjection = resolveConfiguredModelEntries({
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    effectiveDefaultRef: params.effectiveDefaultRef,
    aliasIndex: params.aliasIndex,
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
  });
  const resolvedDefault = configuredProjection.defaultRef;
  const configuredCatalog = configuredProjection.entries.map((entry) => ({
    provider: entry.ref.provider,
    id: entry.ref.model,
    name: entry.ref.model,
  }));

  const keys = new Set<string>();
  const out: ModelPickerCatalogEntry[] = [];

  const push = (entry: ModelPickerCatalogEntry) => {
    pushUniqueCatalogEntry({
      keys,
      out,
      provider: entry.provider,
      id: entry.id ?? "",
      name: entry.name,
      fallbackNameToId: false,
    });
  };

  const visibility = parseConfiguredModelVisibilityEntries({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!visibility.hasEntries) {
    for (const entry of params.allowedModelCatalog) {
      push({
        provider: entry.provider,
        id: entry.id ?? "",
        name: entry.name,
      });
    }
    for (const entry of configuredCatalog) {
      push(entry);
    }
    return out;
  }

  // Expand wildcard policy entries through the same discovered-catalog path as
  // the main model selection policy.
  for (const entry of params.allowedModelCatalog.filter((candidate) =>
    isModelKeyAllowedBySet(
      params.allowedModelKeys,
      modelKey(candidate.provider, candidate.id ?? ""),
    ),
  )) {
    push({
      provider: entry.provider,
      id: entry.id ?? "",
      name: entry.name,
    });
  }

  // Merge exact policy refs that the catalog doesn't know about.
  for (const raw of visibility.exactModelRefs) {
    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      agentId: params.agentId,
      raw,
      defaultProvider: params.defaultProvider,
      aliasIndex: params.policyAliasIndex,
      ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    });
    if (!resolved) {
      continue;
    }
    const catalogEntry = params.allowedModelCatalog.find(
      (entry) =>
        modelKey(entry.provider, entry.id ?? "") ===
        modelKey(resolved.ref.provider, resolved.ref.model),
    );
    push(
      catalogEntry
        ? { provider: catalogEntry.provider, id: catalogEntry.id ?? "", name: catalogEntry.name }
        : {
            provider: resolved.ref.provider,
            id: resolved.ref.model,
            name: resolved.ref.model,
          },
    );
  }

  // A restricted picker must not reintroduce a default rejected by the active policy.
  if (
    resolvedDefault?.model &&
    isModelKeyAllowedBySet(
      params.allowedModelKeys,
      modelKey(resolvedDefault.provider, resolvedDefault.model),
    )
  ) {
    push({
      provider: resolvedDefault.provider,
      id: resolvedDefault.model,
      name: resolvedDefault.model,
    });
  }

  return out;
}

function filterMissingAuthNestedProviderDuplicates(params: {
  cfg: OpenClawConfig;
  entries: ModelPickerCatalogEntry[];
  authByProvider: Map<string, string>;
}): ModelPickerCatalogEntry[] {
  const configuredKeys = new Set(
    buildConfiguredModelCatalog({ cfg: params.cfg }).map((entry) =>
      modelKey(entry.provider, entry.id),
    ),
  );
  const wrapperKeys = new Set<string>();
  for (const entry of params.entries) {
    const id = normalizeOptionalString(entry.id) ?? "";
    const slash = id.indexOf("/");
    if (slash <= 0) {
      continue;
    }
    const nestedProvider = normalizeProviderId(id.slice(0, slash));
    const nestedModel = normalizeOptionalString(id.slice(slash + 1)) ?? "";
    const wrapperProvider = normalizeProviderId(entry.provider);
    if (!nestedProvider || !nestedModel || nestedProvider === wrapperProvider) {
      continue;
    }
    wrapperKeys.add(modelKey(nestedProvider, nestedModel));
  }
  if (wrapperKeys.size === 0) {
    return params.entries;
  }

  return params.entries.filter((entry) => {
    const provider = normalizeProviderId(entry.provider);
    const id = normalizeOptionalString(entry.id) ?? "";
    const key = modelKey(provider, id);
    if (configuredKeys.has(key)) {
      return true;
    }
    return params.authByProvider.get(provider) !== "missing" || !wrapperKeys.has(key);
  });
}

export async function maybeHandleModelDirectiveInfo(params: {
  directives: InlineDirectives;
  cfg: OpenClawConfig;
  agentDir: string;
  activeAgentId: string;
  provider: string;
  model: string;
  defaultProvider: string;
  defaultModel: string;
  effectiveDefaultRef?: { provider: string; model: string } | null;
  aliasIndex: ModelAliasIndex;
  policyAliasIndex?: ModelAliasIndex;
  allowedModelKeys: ReadonlySet<string>;
  allowedModelCatalog: Array<{ provider: string; id?: string; name?: string }>;
  currentThinkLevel: ThinkLevel;
  thinkingCatalog?: ThinkingCatalogEntry[];
  runtimePolicySessionKey?: string;
  sessionKey?: string;
  storePath?: string;
  resetModelOverride: boolean;
  workspaceDir?: string;
  surface?: string;
  sessionEntry?: InternalSessionEntry;
}): Promise<ReplyPayload | undefined> {
  if (!params.directives.hasModelDirective) {
    return undefined;
  }

  const rawDirective = normalizeOptionalString(params.directives.rawModelDirective);
  const directive = rawDirective ? normalizeLowercaseStringOrEmpty(rawDirective) : undefined;
  const isLiteralModelDirective = params.directives.modelDirectiveSource !== "alias";
  const wantsStatus = isLiteralModelDirective && directive === "status";
  const wantsSummary = isLiteralModelDirective && !rawDirective;
  const wantsLegacyList = isLiteralModelDirective && directive === "list";
  if (!wantsSummary && !wantsStatus && !wantsLegacyList) {
    return undefined;
  }

  if (params.directives.rawModelProfile) {
    return { text: "Auth profile override requires a model selection.", isError: true };
  }
  if (params.directives.rawModelRuntime) {
    return { text: "Runtime override requires a model selection.", isError: true };
  }
  if (params.directives.modelScope) {
    const scopeLabel =
      params.directives.modelScope === "session"
        ? "Session-only"
        : params.directives.modelScope === "agent"
          ? "Agent"
          : "Global";
    return {
      text: `${scopeLabel} scope requires a model selection.`,
      isError: true,
    };
  }

  if (wantsLegacyList) {
    const reply = await resolveModelsCommandReply({
      cfg: params.cfg,
      commandBodyNormalized: "/models",
      surface: params.surface,
      currentModel: `${params.provider}/${params.model}`,
      agentId: params.activeAgentId,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      sessionEntry: params.sessionEntry,
      sessionKey: params.sessionKey,
    });
    return reply ?? { text: "No models available." };
  }

  const modelParams = {
    selectedProvider: params.provider,
    selectedModel: params.model,
    sessionEntry: params.sessionEntry,
  };
  const completedModel = readSessionFallbackModel({
    ...modelParams,
    config: params.cfg,
    sessionScope: {
      agentId: params.activeAgentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
  });
  const modelRefs = resolveSelectedAndActiveModel({
    ...modelParams,
    sessionEntry: completedModel ?? params.sessionEntry,
  });
  if (wantsSummary) {
    const current = modelRefs.selected.label;
    const thinkingRuntime = resolveEffectiveAgentRuntime({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.model,
      agentId: params.activeAgentId,
      sessionKey: params.runtimePolicySessionKey,
      sessionEntry: params.sessionEntry,
    });
    const effectiveThinkLevel = resolveSupportedThinkingLevel({
      provider: params.provider,
      model: params.model,
      level: params.currentThinkLevel,
      catalog: params.thinkingCatalog,
      agentRuntime: thinkingRuntime,
    });
    const thinkingLine = `Think: ${effectiveThinkLevel} (change with /think <level>)`;
    const activeRuntimeLine = modelRefs.activeDiffers
      ? `Active: ${modelRefs.active.label} (runtime)`
      : null;
    const commandPlugin = params.surface ? getChannelPlugin(params.surface) : null;
    const channelData = commandPlugin?.commands?.buildModelBrowseChannelData?.();
    if (channelData) {
      return {
        text: [
          `Current: ${current}${modelRefs.activeDiffers ? " (selected)" : ""}`,
          activeRuntimeLine,
          thinkingLine,
          "",
          "Tap below to select a model, or use:",
          "/model <provider/model> -s for this session only",
          "/model <provider/model> -a to update this agent's default",
          "/model <provider/model> -g to update the global default",
          "/model <provider/model> --runtime <runtime> -s to switch harnesses",
          "/model status for details",
        ]
          .filter(Boolean)
          .join("\n"),
        channelData,
      };
    }

    return {
      text: [
        `Current: ${current}${modelRefs.activeDiffers ? " (selected)" : ""}`,
        activeRuntimeLine,
        thinkingLine,
        "",
        "Session: /model <provider/model> -s",
        "Agent default: /model <provider/model> -a",
        "Global default: /model <provider/model> -g",
        "Runtime: /model <provider/model> --runtime <runtime> -s",
        "Browse: /models (providers) or /models <provider> (models)",
        "More: /model status",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const pickerCatalog = buildModelPickerCatalog({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    effectiveDefaultRef: params.effectiveDefaultRef,
    agentId: params.activeAgentId,
    aliasIndex: params.aliasIndex,
    policyAliasIndex: params.policyAliasIndex ?? params.aliasIndex,
    allowedModelKeys: params.allowedModelKeys,
    allowedModelCatalog: params.allowedModelCatalog,
  });
  const formatPath = (value: string) => shortenHomePath(value);
  if (pickerCatalog.length === 0) {
    return { text: "No models available." };
  }

  const { loadPreparedModelCatalogView } = await import("../../agents/model-catalog-view.js");
  const prepared = await loadPreparedModelCatalogView({
    kind: "status",
    config: params.cfg,
    agentId: params.activeAgentId,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    entries: pickerCatalog,
    sessionEntry: params.sessionEntry,
  });
  const authByProvider = prepared.providerAuthLabels;

  const current = modelRefs.selected.label;
  const defaultLabel = `${params.defaultProvider}/${params.defaultModel}`;
  const lines = [
    `Current: ${current}${modelRefs.activeDiffers ? " (selected)" : ""}`,
    modelRefs.activeDiffers ? `Active: ${modelRefs.active.label} (runtime)` : null,
    `Default: ${defaultLabel}`,
    `Agent: ${params.activeAgentId}`,
    `Auth store: ${formatPath(resolveAuthStorePathForDisplay(params.agentDir))}`,
  ].filter((line): line is string => Boolean(line));
  if (params.resetModelOverride) {
    lines.push(`(previous selection reset to default)`);
  }

  const byProvider = new Map<string, ModelPickerCatalogEntry[]>();
  const statusCatalog = filterMissingAuthNestedProviderDuplicates({
    cfg: params.cfg,
    entries: pickerCatalog,
    authByProvider,
  });
  for (const entry of statusCatalog) {
    const provider = normalizeProviderId(entry.provider);
    const models = byProvider.get(provider);
    if (models) {
      models.push(entry);
      continue;
    }
    byProvider.set(provider, [entry]);
  }

  for (const provider of byProvider.keys()) {
    const models = byProvider.get(provider);
    if (!models) {
      continue;
    }
    const authLabel = authByProvider.get(provider) ?? "missing";
    const endpoint = prepared.providerEndpoints.get(provider);
    const endpointSuffix = endpoint?.endpoint
      ? ` endpoint: ${endpoint?.endpoint}`
      : " endpoint: default";
    const apiSuffix = endpoint?.api ? ` api: ${endpoint?.api}` : "";
    lines.push("");
    lines.push(`[${provider}]${endpointSuffix}${apiSuffix} auth: ${authLabel}`);
    for (const entry of models) {
      const label = `${provider}/${entry.id}`;
      const aliases = params.aliasIndex.byKey.get(label);
      const aliasSuffix = aliases && aliases.length > 0 ? ` (${aliases.join(", ")})` : "";
      lines.push(`  • ${label}${aliasSuffix}`);
    }
  }
  return { text: lines.join("\n") };
}
