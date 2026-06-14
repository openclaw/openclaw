// Registers plugin-provided models into the model catalog.
import type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogSource,
} from "@openclaw/model-catalog-core/model-catalog-types";
import {
  synthesizeMediaGenerationCatalogEntries,
  type MediaGenerationCatalogKind,
  type MediaGenerationCatalogProvider,
} from "../../packages/media-generation-core/src/catalog.js";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { uniqueValues } from "../../packages/normalization-core/src/string-normalization.js";
import {
  synthesizeVoiceModelCatalogEntries,
  type VoiceModelCapabilities,
  type VoiceModelProvider,
} from "../../packages/speech-core/voice-models.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { projectProviderCatalogResultToUnifiedTextRows } from "./provider-catalog-unified-text.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import type {
  ProviderPlugin,
  UnifiedModelCatalogProviderContext,
  UnifiedModelCatalogProviderPlugin,
} from "./types.js";

type UnifiedModelCatalogHook = NonNullable<UnifiedModelCatalogProviderPlugin["staticCatalog"]>;

function mergeCatalogHookResults(
  source: UnifiedModelCatalogSource,
  left: readonly UnifiedModelCatalogEntry[] | null | undefined,
  right: readonly UnifiedModelCatalogEntry[] | null | undefined,
): readonly UnifiedModelCatalogEntry[] | null {
  const rows = [...(left ?? []), ...(right ?? [])];
  if (rows.length === 0) {
    return null;
  }
  const mergedRows: UnifiedModelCatalogEntry[] = [];
  for (const row of rows) {
    mergedRows.push({ ...row, source });
  }
  return mergedRows;
}

function mergeModelCatalogHooks(
  source: UnifiedModelCatalogSource,
  left: UnifiedModelCatalogHook | undefined,
  right: UnifiedModelCatalogHook | undefined,
): UnifiedModelCatalogHook | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return async (ctx) => {
    const [leftRows, rightRows] = await Promise.all([left(ctx), right(ctx)]);
    return mergeCatalogHookResults(source, leftRows, rightRows);
  };
}

/** Creates handlers that register plugin model catalog providers into a registry. */
export function createModelCatalogRegistrationHandlers(params: {
  registry: PluginRegistry;
  pushDiagnostic: (diagnostic: PluginDiagnostic) => void;
}) {
  const normalizeModelCatalogProvider = (
    record: PluginRecord,
    provider: UnifiedModelCatalogProviderPlugin,
  ): UnifiedModelCatalogProviderPlugin | null => {
    let providerId: string;
    let normalizedKinds: UnifiedModelCatalogProviderPlugin["kinds"];
    let staticCatalog: UnifiedModelCatalogProviderPlugin["staticCatalog"];
    let liveCatalog: UnifiedModelCatalogProviderPlugin["liveCatalog"];
    try {
      providerId = normalizeOptionalString(provider.provider) ?? "";
      const kinds = provider.kinds;
      if (!Array.isArray(kinds) || kinds.length === 0) {
        normalizedKinds = [];
      } else {
        normalizedKinds = uniqueValues(kinds);
      }
      staticCatalog = provider.staticCatalog;
      liveCatalog = provider.liveCatalog;
    } catch {
      params.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "model catalog provider registration metadata unreadable",
      });
      return null;
    }
    if (!providerId) {
      params.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "model catalog provider registration missing provider",
      });
      return null;
    }
    if (normalizedKinds.length === 0) {
      params.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `model catalog provider "${providerId}" registration missing kinds`,
      });
      return null;
    }
    return {
      provider: providerId,
      kinds: normalizedKinds,
      ...(staticCatalog ? { staticCatalog } : {}),
      ...(liveCatalog ? { liveCatalog } : {}),
    };
  };

  const registerModelCatalogProvider = (
    record: PluginRecord,
    provider: UnifiedModelCatalogProviderPlugin,
  ) => {
    const normalizedProvider = normalizeModelCatalogProvider(record, provider);
    if (!normalizedProvider) {
      return;
    }
    const providerId = normalizedProvider.provider;
    const existing = params.registry.modelCatalogProviders.find(
      (entry) => entry.provider.provider === providerId && entry.pluginId !== record.id,
    );
    if (existing) {
      params.pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `model catalog provider already registered: ${providerId} (${existing.pluginId})`,
      });
      return;
    }
    const normalizedKinds = normalizedProvider.kinds;
    const samePluginOverlapping = params.registry.modelCatalogProviders.find(
      (entry) =>
        entry.provider.provider === providerId &&
        entry.pluginId === record.id &&
        entry.provider.kinds.some((kind) => normalizedKinds.includes(kind)),
    );
    if (samePluginOverlapping) {
      samePluginOverlapping.provider = {
        ...samePluginOverlapping.provider,
        ...normalizedProvider,
        provider: providerId,
        kinds: uniqueValues([...samePluginOverlapping.provider.kinds, ...normalizedKinds]),
        staticCatalog: mergeModelCatalogHooks(
          "static",
          samePluginOverlapping.provider.staticCatalog,
          normalizedProvider.staticCatalog,
        ),
        liveCatalog: mergeModelCatalogHooks(
          "live",
          samePluginOverlapping.provider.liveCatalog,
          normalizedProvider.liveCatalog,
        ),
      };
      return;
    }
    params.registry.modelCatalogProviders.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: {
        ...normalizedProvider,
        provider: providerId,
        kinds: normalizedKinds,
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerSynthesizedTextModelCatalogProvider = (registration: {
    record: PluginRecord;
    provider: ProviderPlugin;
  }) => {
    const providerId = registration.provider.id;
    const staticCatalog = registration.provider.staticCatalog;
    const liveCatalog = registration.provider.catalog;
    if (!liveCatalog && !staticCatalog) {
      return;
    }
    registerModelCatalogProvider(registration.record, {
      provider: providerId,
      kinds: ["text"],
      ...(staticCatalog
        ? {
            staticCatalog: async (ctx: UnifiedModelCatalogProviderContext) =>
              projectProviderCatalogResultToUnifiedTextRows({
                providerId,
                result: await staticCatalog.run(ctx),
                source: "static",
              }),
          }
        : {}),
      ...(liveCatalog
        ? {
            liveCatalog: async (ctx: UnifiedModelCatalogProviderContext) =>
              projectProviderCatalogResultToUnifiedTextRows({
                providerId,
                result: await liveCatalog.run(ctx),
                source: "live",
              }),
          }
        : {}),
    });
  };

  const registerSynthesizedMediaModelCatalogProvider = <TCapabilities>(registration: {
    record: PluginRecord;
    kind: MediaGenerationCatalogKind;
    provider: MediaGenerationCatalogProvider<TCapabilities>;
  }) => {
    registerModelCatalogProvider(registration.record, {
      provider: registration.provider.id,
      kinds: [registration.kind],
      staticCatalog: () =>
        synthesizeMediaGenerationCatalogEntries({
          kind: registration.kind,
          provider: registration.provider,
        }),
    });
  };

  const registerSynthesizedVoiceModelCatalogProvider = (registration: {
    record: PluginRecord;
    provider: VoiceModelProvider;
    capabilities: VoiceModelCapabilities;
    modes?: readonly string[];
  }) => {
    registerModelCatalogProvider(registration.record, {
      provider: registration.provider.id,
      kinds: ["voice"],
      staticCatalog: () =>
        synthesizeVoiceModelCatalogEntries({
          provider: registration.provider,
          capabilities: registration.capabilities,
          modes: registration.modes,
        }),
    });
  };

  return {
    registerModelCatalogProvider,
    registerSynthesizedTextModelCatalogProvider,
    registerSynthesizedMediaModelCatalogProvider,
    registerSynthesizedVoiceModelCatalogProvider,
  };
}
