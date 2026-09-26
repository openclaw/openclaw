import { listMappedModelThinkingLevels } from "@openclaw/model-catalog-core/model-catalog-types";
// Thinking/reasoning level catalog helpers for auto-reply model controls.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Model } from "../llm/types.js";
import { resolveClaudeThinkingProfile } from "../plugins/provider-claude-thinking.js";
import { resolveEffectiveThinkingProfile } from "../plugins/provider-thinking.js";
import type {
  ProviderThinkingPolicySource,
  ProviderThinkingProfile,
} from "../plugins/provider-thinking.types.js";
import { indexFirstByKey } from "../shared/dedupe-by-key.js";
import { modelKey as legacyModelKey } from "../shared/model-key.js";
import {
  BASE_THINKING_LEVELS,
  normalizeThinkLevel,
  THINKING_LEVEL_RANKS,
} from "./thinking.shared.js";
import type { ThinkLevel, ThinkingCatalogEntry } from "./thinking.shared.js";
export {
  isSessionDefaultDirectiveValue,
  normalizeElevatedLevel,
  normalizeFastMode,
  normalizeReasoningLevel,
  normalizeTraceLevel,
  normalizeThinkLevel,
  normalizeUsageDisplay,
  normalizeVerboseLevel,
  resolveEffectiveResponseUsage,
  resolveResponseUsageMode,
} from "./thinking.shared.js";
export type {
  ElevatedLevel,
  FastMode,
  ReasoningLevel,
  TraceLevel,
  ThinkLevel,
  ThinkingCatalogEntry,
  VerboseLevel,
} from "./thinking.shared.js";

/** UI-facing thinking level option. */
type ThinkingLevelOption = {
  id: ThinkLevel;
  label: string;
};

type RankedThinkingLevelOption = ThinkingLevelOption & {
  rank: number;
};

type ResolvedThinkingProfile = {
  levels: RankedThinkingLevelOption[];
  defaultLevel?: ThinkLevel | null;
};

function buildCatalogModelKey(provider: string, model: string, legacy = false): string {
  const providerId = normalizeProviderId(provider);
  const modelId = model.trim();
  return JSON.stringify([providerId, legacy ? legacyModelKey(providerId, modelId) : modelId]);
}

type ThinkingCatalogQuery = {
  provider?: string | null;
  model?: string | null;
};

type ThinkingProfileParams = ThinkingCatalogQuery & {
  catalog?: ThinkingCatalogEntry[];
  catalogResolver?: ThinkingCatalogResolver;
  agentRuntime?: string | null;
  configuredReasoning?: boolean;
  providerPolicySource?: ProviderThinkingPolicySource;
};

export type ThinkingCatalogResolver = (
  params: ThinkingCatalogQuery,
) => ThinkingCatalogEntry | undefined;

function resolveThinkingCatalogKeys(params: ThinkingCatalogQuery) {
  const providerRaw = normalizeOptionalString(params.provider);
  const normalizedProvider = providerRaw ? normalizeProviderId(providerRaw) : "";
  const modelId = normalizeOptionalString(params.model) ?? "";
  return normalizedProvider && modelId
    ? {
        literal: buildCatalogModelKey(normalizedProvider, modelId),
        legacy: buildCatalogModelKey(normalizedProvider, modelId, true),
      }
    : undefined;
}

/** Indexes one prepared catalog while retaining its first matching row and policy owner. */
export function createThinkingCatalogResolver(
  catalog: readonly ThinkingCatalogEntry[],
): ThinkingCatalogResolver {
  const byKey = indexFirstByKey(catalog, (entry) => buildCatalogModelKey(entry.provider, entry.id));
  const byLegacyKey = indexFirstByKey(catalog, (entry) =>
    buildCatalogModelKey(entry.provider, entry.id, true),
  );
  return (params) => {
    const keys = resolveThinkingCatalogKeys(params);
    return keys === undefined
      ? undefined
      : (byKey.get(keys.literal) ?? byLegacyKey.get(keys.legacy));
  };
}

function resolveThinkingCatalogEntry(
  params: ThinkingProfileParams,
): ThinkingCatalogEntry | undefined {
  if (params.catalogResolver) {
    return params.catalogResolver(params);
  }
  const keys = resolveThinkingCatalogKeys(params);
  if (keys === undefined) {
    return undefined;
  }
  // Older catalog rows may include their provider prefix. Match them only after literal
  // identity, and stay within the same provider so aliases cannot borrow capabilities.
  return (
    params.catalog?.find(
      (entry) => buildCatalogModelKey(entry.provider, entry.id) === keys.literal,
    ) ??
    params.catalog?.find(
      (entry) => buildCatalogModelKey(entry.provider, entry.id, true) === keys.legacy,
    )
  );
}

function resolveThinkingPolicyContext(params: ThinkingProfileParams) {
  const providerRaw = normalizeOptionalString(params.provider);
  const modelId = normalizeOptionalString(params.model) ?? "";
  const modelKey = normalizeOptionalLowercaseString(params.model) ?? "";
  const candidate = resolveThinkingCatalogEntry(params);
  const thinkingPolicyProvider = normalizeOptionalString(candidate?.thinkingPolicyProvider);
  // Prepared catalogs keep the logical model identity but record the concrete
  // runtime policy owner so every session and directive surface stays aligned.
  const normalizedProvider = providerRaw
    ? normalizeProviderId(thinkingPolicyProvider ?? providerRaw)
    : "";
  return {
    catalogEntry: candidate,
    normalizedProvider,
    modelId,
    modelKey,
    api: candidate?.api,
    reasoning: params.configuredReasoning ?? candidate?.configuredReasoning ?? candidate?.reasoning,
    thinkingLevelMap: candidate?.thinkingLevelMap,
    ...(candidate?.params ? { params: candidate.params } : {}),
    compat: candidate?.compat,
  };
}

function normalizeProfileLevel(
  level: ProviderThinkingProfile["levels"][number],
): RankedThinkingLevelOption | undefined {
  const normalized = normalizeThinkLevel(level.id);
  if (!normalized) {
    return undefined;
  }
  return {
    id: normalized,
    label: normalizeOptionalString(level.label) ?? normalized,
    rank: Number.isFinite(level.rank) ? (level.rank as number) : THINKING_LEVEL_RANKS[normalized],
  };
}

function normalizeThinkingProfile(
  profile: ProviderThinkingProfile,
  thinkingLevelMap: ThinkingCatalogEntry["thinkingLevelMap"],
  mappedLevels: readonly ("xhigh" | "max")[] = [],
): ResolvedThinkingProfile {
  const byId = new Map<ThinkLevel, RankedThinkingLevelOption>();
  for (const raw of profile.levels) {
    const level = normalizeProfileLevel(raw);
    if (
      level &&
      (level.id === "adaptive" || level.id === "ultra" || thinkingLevelMap?.[level.id] !== null)
    ) {
      byId.set(level.id, level);
    }
  }
  const levels = [...byId.values()].toSorted((a, b) => a.rank - b.rank);
  const rawDefaultLevel = profile.defaultLevel
    ? normalizeThinkLevel(profile.defaultLevel)
    : undefined;
  const defaultLevel = rawDefaultLevel && byId.has(rawDefaultLevel) ? rawDefaultLevel : undefined;
  const normalized = { levels, defaultLevel };
  if (profile.levels.length > 0) {
    for (const level of mappedLevels) {
      if (thinkingLevelMap?.[level] !== null) {
        appendProfileLevel(normalized, level);
      }
    }
  }
  return normalized;
}

function buildBaseThinkingProfile(defaultLevel?: ThinkLevel | null): ResolvedThinkingProfile {
  return {
    levels: BASE_THINKING_LEVELS.map((id) => ({
      id,
      label: id,
      rank: THINKING_LEVEL_RANKS[id],
    })),
    defaultLevel,
  };
}

function buildOffOnlyThinkingProfile(): ResolvedThinkingProfile {
  return {
    levels: [{ id: "off", label: "off", rank: THINKING_LEVEL_RANKS.off }],
    defaultLevel: "off",
  };
}

function appendProfileLevel(profile: ResolvedThinkingProfile, id: ThinkLevel) {
  if (profile.levels.some((level) => level.id === id)) {
    return;
  }
  profile.levels.push({ id, label: id, rank: THINKING_LEVEL_RANKS[id] });
  profile.levels = profile.levels.toSorted((a, b) => a.rank - b.rank);
}

function appendCatalogAdvancedThinkingLevels(
  profile: ResolvedThinkingProfile,
  compat: ThinkingCatalogEntry["compat"],
  thinkingLevelMap: ThinkingCatalogEntry["thinkingLevelMap"],
) {
  if (thinkingLevelMap) {
    for (const level of ["xhigh", "max"] as const) {
      if (thinkingLevelMap[level] !== undefined && thinkingLevelMap[level] !== null) {
        appendProfileLevel(profile, level);
      }
    }
  }
  for (const level of compat?.supportedReasoningEfforts ?? []) {
    if (
      level === "ultra" ||
      ((level === "adaptive" || level === "xhigh" || level === "max") &&
        (level === "adaptive" || thinkingLevelMap?.[level] !== null))
    ) {
      appendProfileLevel(profile, level);
    }
  }
}

/** Resolve only provider-owned effort choices, before adding harness modes. */
function resolveModelThinkingProfile(params: ThinkingProfileParams): ResolvedThinkingProfile {
  const context = resolveThinkingPolicyContext(params);
  if (!context.normalizedProvider) {
    return buildBaseThinkingProfile();
  }
  const providerContext = {
    provider: context.normalizedProvider,
    modelId: context.modelId,
    agentRuntime: params.agentRuntime,
    api: context.api,
    reasoning: context.reasoning,
    thinkingLevelMap: context.thinkingLevelMap,
    ...(context.params ? { params: context.params } : {}),
    compat: context.compat,
  };
  const providerProfileParams = {
    provider: context.normalizedProvider,
    context: providerContext,
    ...(context.catalogEntry ? { catalogEntry: context.catalogEntry } : {}),
  };
  const providerProfile =
    typeof params.providerPolicySource === "object"
      ? resolveEffectiveThinkingProfile(providerProfileParams, {
          registry: params.providerPolicySource,
        })
      : params.providerPolicySource === "active"
        ? resolveEffectiveThinkingProfile(providerProfileParams, {
            allowPublicArtifactFallback: false,
          })
        : resolveEffectiveThinkingProfile(providerProfileParams);
  // Any anthropic-messages catalog row routes through the canonical Claude
  // resolver: Claude families get the proper profile (incl. xhigh/adaptive/max);
  // non-Claude models on the anthropic-messages transport collapse to the Claude
  // base set, deliberately bypassing the later compat-driven xhigh upgrade —
  // anthropic-messages does not carry a generic xhigh contract.
  const anthropicMessagesProfile =
    context.api === "anthropic-messages"
      ? resolveClaudeThinkingProfile(context.modelId, context.params, {
          includeNativeMax: true,
        })
      : undefined;
  const pluginProfile = providerProfile ?? anthropicMessagesProfile;
  const runtime = normalizeOptionalLowercaseString(params.agentRuntime);
  const mappedLevels =
    !runtime || runtime === "auto" || runtime === "openclaw"
      ? listMappedModelThinkingLevels(context).filter(
          (level) => level === "xhigh" || level === "max",
        )
      : [];
  if (
    pluginProfile &&
    (context.reasoning !== false || pluginProfile.preserveWhenCatalogReasoningFalse === true)
  ) {
    return normalizeThinkingProfile(pluginProfile, context.thinkingLevelMap, mappedLevels);
  }
  if (context.reasoning === false) {
    return buildOffOnlyThinkingProfile();
  }

  // Qwen chat templates apply their own default effort (xhigh for Qwen 3.8) when a request
  // omits reasoning_effort. High maps to that tier, so an unset level keeps the backend's
  // depth instead of dropping to the generic medium fallback.
  const profile = buildBaseThinkingProfile(
    context.compat?.thinkingFormat === "qwen-chat-template" ? "high" : undefined,
  );
  appendCatalogAdvancedThinkingLevels(profile, context.compat, context.thinkingLevelMap);
  return normalizeThinkingProfile(profile, context.thinkingLevelMap, mappedLevels);
}

/** Ultra is a harness mode, independent of a model's native reasoning controls. */
export function resolveThinkingProfile(params: ThinkingProfileParams): ResolvedThinkingProfile {
  const profile = resolveModelThinkingProfile(params);
  const runtime = normalizeOptionalLowercaseString(params.agentRuntime);
  const hostUltra = runtime === "openclaw" || runtime === "auto" || runtime === "claude-cli";
  // Codex owns Ultra inference and cannot omit effort for an empty native ladder.
  const nativeUltra =
    runtime === "codex" && profile.levels.some(({ id }) => id !== "off" && id !== "ultra");
  if (hostUltra || nativeUltra) {
    appendProfileLevel(profile, "ultra");
  }
  return profile;
}

/** Lower harness-only Ultra at a provider boundary without inventing native effort support. */
export function resolveProviderThinkingLevel(
  params: Omit<ThinkingProfileParams, "catalog"> & {
    catalog?: (ThinkingCatalogEntry | Model)[];
    level?: ThinkLevel;
  },
): Exclude<ThinkLevel, "ultra"> | undefined {
  if (params.level !== "ultra") {
    return params.level;
  }
  const catalog = params.catalog?.map(({ compat, ...entry }) => ({
    ...entry,
    // Transport-only compatibility (for example Anthropic cache controls) is
    // not thinking metadata. Preserve every declared thinking capability.
    compat:
      compat &&
      ("thinkingFormat" in compat ||
        "supportsReasoningEffort" in compat ||
        "supportedReasoningEfforts" in compat ||
        "reasoningEffortMap" in compat)
        ? compat
        : undefined,
  }));
  const profile = resolveModelThinkingProfile({ ...params, catalog });
  return profile.levels
    .filter(
      (entry): entry is RankedThinkingLevelOption & { id: Exclude<ThinkLevel, "ultra"> } =>
        entry.id !== "ultra",
    )
    .toSorted((a, b) => b.rank - a.rank)[0]?.id;
}

/** List thinking level ids supported by provider/model. */
export function listThinkingLevels(
  provider?: string | null,
  model?: string | null,
  catalog?: ThinkingCatalogEntry[],
  agentRuntime?: string | null,
): ThinkLevel[] {
  const profile = resolveThinkingProfile({ provider, model, catalog, agentRuntime });
  return profile.levels.map((level) => level.id);
}

/** List labeled thinking level options supported by provider/model. */
export function listThinkingLevelOptions(
  provider?: string | null,
  model?: string | null,
  catalog?: ThinkingCatalogEntry[],
  agentRuntime?: string | null,
): ThinkingLevelOption[] {
  const profile = resolveThinkingProfile({ provider, model, catalog, agentRuntime });
  return profile.levels.map(({ id, label }) => ({ id, label }));
}

/** List display labels for thinking levels supported by provider/model. */
export function listThinkingLevelLabels(
  provider?: string | null,
  model?: string | null,
  catalog?: ThinkingCatalogEntry[],
  agentRuntime?: string | null,
): string[] {
  return listThinkingLevelOptions(provider, model, catalog, agentRuntime).map(
    (level) => level.label,
  );
}

/** Format supported thinking level labels for command/status output. */
export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  separator = ", ",
  catalog?: ThinkingCatalogEntry[],
  agentRuntime?: string | null,
): string {
  const profile = resolveThinkingProfile({ provider, model, catalog, agentRuntime });
  return profile.levels.map(({ label }) => label).join(separator);
}

/** Resolve the default thinking level for a provider/model pair. */
export function resolveThinkingDefaultForModel(
  params: Omit<ThinkingProfileParams, "provider" | "model" | "configuredReasoning"> & {
    provider: string;
    model: string;
  },
): ThinkLevel {
  return resolveThinkingSelectionForModel({
    ...params,
    agentRuntime: params.agentRuntime,
  }).requestedLevel;
}

/** Resolve intent, support, and execution level from one selected model profile. */
export function resolveThinkingSelectionForModel(
  params: ThinkingProfileParams & {
    level?: ThinkLevel;
    agentRuntime: string | null | undefined;
  },
): { requestedLevel: ThinkLevel; level: ThinkLevel; supported: boolean } {
  const candidate = resolveThinkingCatalogEntry(params);
  const profile = resolveThinkingProfile({
    ...params,
    catalogResolver: () => candidate,
  });
  const requestedLevel =
    params.level ??
    profile.defaultLevel ??
    (candidate?.reasoning ? resolveSupportedThinkingLevelFromProfile(profile, "medium") : "off");
  return {
    requestedLevel,
    level: resolveSupportedThinkingLevelFromProfile(profile, requestedLevel),
    // An empty profile may remap Off to Off without admitting it as a valid choice.
    supported: profile.levels.some((entry) => entry.id === requestedLevel),
  };
}

/** Return whether a specific thinking level is supported by provider/model. */
export function isThinkingLevelSupported(
  params: Omit<ThinkingProfileParams, "catalogResolver" | "providerPolicySource"> & {
    level: ThinkLevel;
  },
): boolean {
  return resolveThinkingSelectionForModel({
    ...params,
    agentRuntime: params.agentRuntime,
  }).supported;
}

export function resolveSupportedThinkingLevelFromProfile(
  profile: ResolvedThinkingProfile,
  level: ThinkLevel,
): ThinkLevel {
  if (profile.levels.some((entry) => entry.id === level)) {
    return level;
  }
  if (level === "adaptive" && profile.defaultLevel && profile.defaultLevel !== "off") {
    return profile.defaultLevel;
  }
  const requestedRank = THINKING_LEVEL_RANKS[level];
  // A fallback or default must never opt into proactive orchestration.
  const ranked = profile.levels
    .filter((entry) => entry.id !== "ultra")
    .toSorted((a, b) => b.rank - a.rank);
  return (
    ranked.find((entry) => entry.id !== "off" && entry.rank <= requestedRank)?.id ??
    ranked.findLast((entry) => entry.id !== "off")?.id ??
    "off"
  );
}

/** Clamp a requested thinking level to the closest supported provider/model level. */
export function resolveSupportedThinkingLevel(
  params: ThinkingProfileParams & { level: ThinkLevel },
): ThinkLevel {
  return resolveThinkingSelectionForModel({ ...params, agentRuntime: params.agentRuntime }).level;
}
