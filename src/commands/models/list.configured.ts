/** Resolves configured model refs and tags for model-list rows. */
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { normalizeConfiguredProviderCatalogModelId } from "../../agents/model-ref-shared.js";
import {
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import type { ListRowModel } from "./list.model-row.js";
import type { ConfiguredEntry } from "./list.types.js";
import {
  createModelCatalogProviderAliasCanonicalizer,
  type ModelCatalogProviderAliasCanonicalizer,
} from "./provider-aliases.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./shared.js";

const DISPLAY_MODEL_PARSE_OPTIONS = { allowPluginNormalization: false } as const;

export type ConfiguredProviderCandidate = {
  model: ListRowModel;
  explicitApi: boolean;
};

/** Builds the canonical configured-provider rows once for every list source. */
export function resolveConfiguredProviderCandidates(
  cfg: OpenClawConfig,
  canonicalize: ModelCatalogProviderAliasCanonicalizer,
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">,
): Map<string, ConfiguredProviderCandidate> {
  const candidates = new Map<string, ConfiguredProviderCandidate>();
  for (const [rawProvider, providerConfig] of Object.entries(cfg.models?.providers ?? {})) {
    const provider = canonicalize.provider(rawProvider);
    for (const model of providerConfig.models ?? []) {
      const id = normalizeConfiguredProviderCatalogModelId(provider, model.id, {
        manifestPlugins: metadataSnapshot?.manifestRegistry.plugins,
      });
      const key = canonicalize.key(provider, id);
      // Config order decides alias/case collisions so every source sees one stable row.
      if (candidates.has(key)) {
        continue;
      }
      const input = model.input?.filter((item) => item === "text" || item === "image") ?? [];
      candidates.set(key, {
        model: {
          provider,
          id,
          name: model.name ?? model.id,
          baseUrl: model.baseUrl ?? providerConfig.baseUrl,
          input: input.length > 0 ? input : ["text"],
          contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
          contextTokens: model.contextTokens,
        },
        explicitApi: providerConfig.api !== undefined || model.api !== undefined,
      });
    }
  }
  return candidates;
}

/** Returns canonical configured model entries with default/fallback/image/configured tags. */
export function resolveConfiguredEntries(
  cfg: OpenClawConfig,
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">,
  canonicalizeProviderAlias = createModelCatalogProviderAliasCanonicalizer({
    cfg,
    metadataSnapshot,
  }),
) {
  const resolvedDefault = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    ...DISPLAY_MODEL_PARSE_OPTIONS,
  });
  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    ...DISPLAY_MODEL_PARSE_OPTIONS,
  });
  const order: Array<{ key: string; ref: { provider: string; model: string } }> = [];
  const tagsByKey = new Map<string, Set<string>>();
  const aliasesByKey = new Map<string, string[]>();
  for (const [key, aliases] of aliasIndex.byKey.entries()) {
    const canonicalKey = canonicalizeProviderAlias.keyFromString(key);
    aliasesByKey.set(canonicalKey, [
      ...new Set([...(aliasesByKey.get(canonicalKey) ?? []), ...aliases]),
    ]);
  }

  const addEntry = (ref: { provider: string; model: string }, tag: string) => {
    const canonicalRef = canonicalizeProviderAlias.ref(ref);
    const key = canonicalizeProviderAlias.key(canonicalRef.provider, canonicalRef.model);
    if (!tagsByKey.has(key)) {
      tagsByKey.set(key, new Set());
      order.push({ key, ref: canonicalRef });
    }
    tagsByKey.get(key)?.add(tag);
  };

  const addResolvedModelRef = (raw: string, tag: string) => {
    const resolved = resolveModelRefFromString({
      cfg,
      raw,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
      ...DISPLAY_MODEL_PARSE_OPTIONS,
    });
    if (resolved) {
      addEntry(resolved.ref, tag);
    }
  };

  addEntry(resolvedDefault, "default");

  const modelFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
  const imageFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel);
  const imagePrimary = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel) ?? "";

  modelFallbacks.forEach((raw, idx) => {
    addResolvedModelRef(raw, `fallback#${idx + 1}`);
  });

  if (imagePrimary) {
    addResolvedModelRef(imagePrimary, "image");
  }

  imageFallbacks.forEach((raw, idx) => {
    addResolvedModelRef(raw, `img-fallback#${idx + 1}`);
  });

  for (const key of Object.keys(cfg.agents?.defaults?.models ?? {})) {
    if (key.trim().endsWith("/*")) {
      continue;
    }
    const resolved = resolveModelRefFromString({
      cfg,
      raw: key,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
      ...DISPLAY_MODEL_PARSE_OPTIONS,
    });
    if (!resolved) {
      continue;
    }
    addEntry(resolved.ref, "configured");
  }

  const entries: ConfiguredEntry[] = order.map(({ key, ref }) => {
    return {
      key,
      ref,
      tags: tagsByKey.get(key) ?? new Set(),
      aliases: aliasesByKey.get(key) ?? [],
    } satisfies ConfiguredEntry;
  });

  return { entries };
}
