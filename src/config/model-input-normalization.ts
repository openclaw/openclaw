// Normalizes user-submitted model config at config mutation boundaries.
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

const MODEL_SELECTION_KEYS = ["model", "imageModel", "voiceModel", "pdfModel"] as const;
const MEDIA_MODEL_KEYS = ["image", "video", "music"] as const;

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
    ((parentIndex === scopeIndex && path[scopeIndex] === "model") ||
      (parentIndex === scopeIndex + 1 &&
        path[scopeIndex] === "subagents" &&
        path[parentIndex] === "model"));
  const isToolModel =
    isDefaults &&
    ((parentIndex === 2 &&
      MODEL_SELECTION_KEYS.some((key) => key !== "model" && key === path[2])) ||
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

  let next = value;
  const assign = (key: string, candidate: unknown) => {
    if (candidate === next[key]) {
      return;
    }
    next = { ...next, [key]: candidate };
  };

  for (const key of MODEL_SELECTION_KEYS) {
    if (Object.hasOwn(value, key)) {
      assign(key, normalizeAgentModelSelectionForConfig(value[key]));
    }
  }
  if (Object.hasOwn(value, "utilityModel")) {
    assign("utilityModel", normalizeStringModelRef(value.utilityModel));
  }
  const originalMediaModels = value.mediaModels;
  if (isRecord(originalMediaModels)) {
    let mediaModels: unknown = originalMediaModels;
    for (const key of MEDIA_MODEL_KEYS) {
      mediaModels = normalizeNestedModelField(
        mediaModels,
        key,
        normalizeAgentModelSelectionForConfig,
      );
    }
    assign("mediaModels", mediaModels);
  }
  assign("heartbeat", normalizeNestedModelField(value.heartbeat, "model", normalizeStringModelRef));
  assign(
    "subagents",
    normalizeNestedModelField(value.subagents, "model", normalizeAgentModelSelectionForConfig),
  );

  if (isRecord(value.compaction)) {
    let compaction = normalizeNestedModelField(value.compaction, "model", normalizeStringModelRef);
    if (isRecord(compaction)) {
      const memoryFlush = normalizeNestedModelField(
        compaction.memoryFlush,
        "model",
        normalizeStringModelRef,
      );
      if (memoryFlush !== compaction.memoryFlush) {
        compaction = { ...compaction, memoryFlush };
      }
    }
    assign("compaction", compaction);
  }
  if (isRecord(value.models)) {
    assign("models", normalizeAgentModelMapForConfig(value.models));
  }
  return next;
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
  modelIdNormalizationPolicies?: ReadonlyMap<string, ManifestModelIdNormalizationProvider>,
): unknown {
  if (!isRecord(models) || !isRecord(models.providers)) {
    return models;
  }

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
        const id = normalizeConfiguredProviderCatalogModelId(
          providerId,
          trimmed,
          modelIdNormalizationPolicies,
        );
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
  modelIdNormalizationPolicies?: ReadonlyMap<string, ManifestModelIdNormalizationProvider>,
): OpenClawConfig {
  let next = cfg;
  const agents = normalizeAgentScopes(cfg.agents);
  if (agents !== cfg.agents) {
    next = { ...next, agents: agents as OpenClawConfig["agents"] };
  }
  const models = normalizeProviderCatalogs(cfg.models, modelIdNormalizationPolicies);
  if (models !== cfg.models) {
    next = { ...next, models: models as OpenClawConfig["models"] };
  }
  // tools.subagents owns only tool policy; model selection moved to
  // agents.defaults/entries.*.subagents.model and the schema rejects the old key.
  return next;
}
