import { normalizeModelCatalogProviderRows } from "./normalize.js";
import { normalizeModelCatalogProviderId } from "./refs.js";
export function planManifestModelCatalogRows(params) {
    const providerFilter = params.providerFilter
        ? normalizeModelCatalogProviderId(params.providerFilter)
        : undefined;
    const entries = [];
    for (const plugin of params.registry.plugins) {
        for (const entry of planManifestModelCatalogPluginEntries({ plugin, providerFilter })) {
            entries.push(entry);
        }
    }
    const rowCandidates = [];
    const seenRows = new Map();
    const conflicts = new Map();
    for (const entry of entries) {
        for (const row of entry.rows) {
            const seen = seenRows.get(row.mergeKey);
            if (seen) {
                if (!conflicts.has(row.mergeKey)) {
                    conflicts.set(row.mergeKey, {
                        mergeKey: row.mergeKey,
                        ref: seen.row.ref,
                        provider: seen.row.provider,
                        modelId: seen.row.id,
                        firstPluginId: seen.pluginId,
                        secondPluginId: entry.pluginId,
                    });
                }
                continue;
            }
            seenRows.set(row.mergeKey, { pluginId: entry.pluginId, row });
            rowCandidates.push(row);
        }
    }
    const conflictedMergeKeys = new Set(conflicts.keys());
    const rows = rowCandidates.filter((row) => !conflictedMergeKeys.has(row.mergeKey));
    return {
        entries,
        conflicts: [...conflicts.values()],
        rows: rows.toSorted((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id)),
    };
}
function planManifestModelCatalogPluginEntries(params) {
    const providers = params.plugin.modelCatalog?.providers;
    if (!providers) {
        return [];
    }
    return Object.entries(providers).flatMap(([provider, providerCatalog]) => {
        const normalizedProvider = normalizeModelCatalogProviderId(provider);
        if (!normalizedProvider ||
            (params.providerFilter && normalizedProvider !== params.providerFilter)) {
            return [];
        }
        const rows = normalizeModelCatalogProviderRows({
            provider: normalizedProvider,
            providerCatalog,
            source: "manifest",
        });
        if (rows.length === 0) {
            return [];
        }
        return [
            {
                pluginId: params.plugin.id,
                provider: normalizedProvider,
                rows,
            },
        ];
    });
}
