// Normalizes user-submitted model config at config mutation boundaries.
import { AGENT_MODEL_CONFIG_KEYS } from "@openclaw/model-catalog-core/configured-model-refs";
import {
  normalizeConfiguredProviderCatalogModelId,
  type ManifestModelIdNormalizationProvider,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { isRecord } from "../utils.js";
import {
  normalizeAgentModelMapForConfig,
  normalizeAgentModelRefForConfig,
  normalizeAgentModelSelectionForConfig,
  toAgentModelListLike,
} from "./model-input.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const MEDIA_MODEL_KEYS = ["image", "video", "music"] as const;

type ModelIdNormalizationPolicies = ReadonlyMap<string, ManifestModelIdNormalizationProvider>;
type ModelIdNormalizationPolicySource =
  | ModelIdNormalizationPolicies
  | (() => ModelIdNormalizationPolicies);

/** Preserve a string model when a path write enters its supported object form. */
export function normalizeConfigModelSelectionParent(
  value: unknown,
  path: readonly string[],
  parentIndex: number,
): ReturnType<typeof toAgentModelListLike> {
  if (typeof value !== "string") {
    return undefined;
  }
  const member = path[parentIndex + 1];
  if (member !== "primary" && member !== "fallbacks" && member !== "timeoutMs") {
    return undefined;
  }
  const isDefaults = path[0] === "agents" && path[1] === "defaults";
  const isAgentEntry =
    path[0] === "agents" &&
    ((path[1] === "entries" && Boolean(path[2])) ||
      (path[1] === "list" && parseConfigPathArrayIndex(path[2] ?? "") !== undefined));
  const scopeIndex = isDefaults ? 2 : isAgentEntry ? 3 : undefined;
  const isAgentModel =
    scopeIndex !== undefined &&
    ((parentIndex === scopeIndex &&
      (path[scopeIndex] === "model" || path[scopeIndex] === "utilityModel")) ||
      (parentIndex === scopeIndex + 1 &&
        path[scopeIndex] === "subagents" &&
        path[parentIndex] === "model"));
  const isToolModel =
    isDefaults &&
    ((parentIndex === 2 &&
      AGENT_MODEL_CONFIG_KEYS.some(
        (key) => key !== "model" && key !== "utilityModel" && key === path[2],
      )) ||
      (parentIndex === 3 &&
        path[2] === "mediaModels" &&
        MEDIA_MODEL_KEYS.some((key) => key === path[3])));
  const reviewerStart = isAgentEntry ? 3 : 0;
  const isReviewerModel =
    parentIndex === reviewerStart + 3 &&
    path[reviewerStart] === "tools" &&
    path[reviewerStart + 1] === "exec" &&
    path[reviewerStart + 2] === "reviewer" &&
    path[parentIndex] === "model";
  if (
    (!isAgentModel && !isToolModel && !isReviewerModel) ||
    (member === "timeoutMs" && !isToolModel)
  ) {
    return undefined;
  }
  if (path[parentIndex] === "utilityModel") {
    return { primary: value.trim() };
  }
  return toAgentModelListLike(value);
}

function normalizeStringModelRef(value: unknown): unknown {
  return typeof value === "string" ? normalizeAgentModelRefForConfig(value) : value;
}

function normalizeNestedModelField(
  value: unknown,
  key: string,
  normalize: (candidate: unknown) => unknown,
): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, key)) {
    return value;
  }
  const normalized = normalize(value[key]);
  return normalized === value[key] ? value : { ...value, [key]: normalized };
}

function normalizeAgentModelScope(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  let next: unknown = value;
  for (const key of AGENT_MODEL_CONFIG_KEYS) {
    next = normalizeNestedModelField(next, key, normalizeAgentModelSelectionForConfig);
  }
  next = normalizeNestedModelField(next, "mediaModels", (mediaModels) => {
    let nextMediaModels = mediaModels;
    for (const key of MEDIA_MODEL_KEYS) {
      nextMediaModels = normalizeNestedModelField(
        nextMediaModels,
        key,
        normalizeAgentModelSelectionForConfig,
      );
    }
    return nextMediaModels;
  });
  next = normalizeNestedModelField(next, "heartbeat", (heartbeat) =>
    normalizeNestedModelField(heartbeat, "model", normalizeStringModelRef),
  );
  next = normalizeNestedModelField(next, "subagents", (subagents) =>
    normalizeNestedModelField(subagents, "model", normalizeAgentModelSelectionForConfig),
  );
  next = normalizeNestedModelField(next, "compaction", (compaction) =>
    normalizeNestedModelField(
      normalizeNestedModelField(compaction, "model", normalizeStringModelRef),
      "memoryFlush",
      (memoryFlush) => normalizeNestedModelField(memoryFlush, "model", normalizeStringModelRef),
    ),
  );
  return normalizeNestedModelField(next, "models", (models) =>
    isRecord(models) ? normalizeAgentModelMapForConfig(models) : models,
  );
}

function normalizeAgentScopes(agents: unknown): unknown {
  if (!isRecord(agents)) {
    return agents;
  }
  let next = agents;
  const assign = (key: string, candidate: unknown) => {
    if (candidate === next[key]) {
      return;
    }
    next = { ...next, [key]: candidate };
  };

  if (Object.hasOwn(agents, "defaults")) {
    assign("defaults", normalizeAgentModelScope(agents.defaults));
  }
  if (isRecord(agents.entries)) {
    let entriesChanged = false;
    const entries = Object.fromEntries(
      Object.entries(agents.entries).map(([agentId, entry]) => {
        const normalized = normalizeAgentModelScope(entry);
        entriesChanged ||= normalized !== entry;
        return [agentId, normalized];
      }),
    );
    if (entriesChanged) {
      assign("entries", entries);
    }
  }
  if (Array.isArray(agents.list)) {
    const originalList = agents.list;
    const list = originalList.map(normalizeAgentModelScope);
    if (list.some((entry, index) => entry !== originalList[index])) {
      assign("list", list);
    }
  }
  return next;
}

function normalizeProviderCatalogs(
  models: unknown,
  modelIdNormalizationPolicies?: ModelIdNormalizationPolicySource,
): unknown {
  if (!isRecord(models) || !isRecord(models.providers)) {
    return models;
  }

  let policies: ModelIdNormalizationPolicies | undefined;
  let providersChanged = false;
  const providers = Object.fromEntries(
    Object.entries(models.providers).map(([providerId, providerValue]) => {
      if (!isRecord(providerValue) || !Array.isArray(providerValue.models)) {
        return [providerId, providerValue];
      }
      const originalModels = providerValue.models;
      const providerModels = originalModels.map((model) => {
        if (!isRecord(model) || typeof model.id !== "string") {
          return model;
        }
        const trimmed = model.id.trim();
        if (!trimmed) {
          return model;
        }
        // Only catalog IDs consume manifest policies; agent refs use core rules.
        policies ??=
          typeof modelIdNormalizationPolicies === "function"
            ? modelIdNormalizationPolicies()
            : modelIdNormalizationPolicies;
        const id = normalizeConfiguredProviderCatalogModelId(providerId, trimmed, policies);
        return id === model.id ? model : { ...model, id };
      });
      if (providerModels.every((model, index) => model === originalModels[index])) {
        return [providerId, providerValue];
      }
      providersChanged = true;
      return [providerId, { ...providerValue, models: providerModels }];
    }),
  );
  return providersChanged ? { ...models, providers } : models;
}

/** Canonicalize model refs submitted through a config mutation API before persistence. */
export function normalizeSubmittedConfigModelRefs(
  cfg: OpenClawConfig,
  modelIdNormalizationPolicies?: ModelIdNormalizationPolicySource,
  options: { normalizeProviderCatalogs?: boolean } = {},
): OpenClawConfig {
  let next = cfg;
  const agents = normalizeAgentScopes(cfg.agents);
  if (agents !== cfg.agents) {
    next = { ...next, agents: agents as OpenClawConfig["agents"] };
  }
  const models =
    options.normalizeProviderCatalogs === false
      ? cfg.models
      : normalizeProviderCatalogs(cfg.models, modelIdNormalizationPolicies);
  if (models !== cfg.models) {
    next = { ...next, models: models as OpenClawConfig["models"] };
  }
  // tools.subagents owns only tool policy; model selection moved to
  // agents.defaults/entries.*.subagents.model and the schema rejects the old key.
  return next;
}
