import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { normalizeModelCompat } from "../plugins/provider-model-compat.js";
import {
  projectUpstreamProviderCatalogModel,
  readLiveModelCatalogId,
  type ProjectedUpstreamProviderCatalogModel,
  type UpstreamProviderCatalog,
} from "./provider-catalog-live-normalize.internal.js";

export type ProviderCatalogSnapshot = ReadonlyMap<
  string,
  {
    model: ProjectedUpstreamProviderCatalogModel;
    status?: "deprecated" | "preview";
    replacedBy?: string;
  }
>;

/** Rebuilds public metadata from trusted seeds without retaining withdrawn upstream rows. */
export function projectUpstreamProviderCatalogSnapshot(params: {
  providerId: string;
  provider: UpstreamProviderCatalog;
  seed: ProviderCatalogSnapshot;
  anthropicBaseUrl: string;
  defaultBaseUrl: string;
  decorateModel?: (
    model: ProjectedUpstreamProviderCatalogModel,
  ) => ProjectedUpstreamProviderCatalogModel;
}): ProviderCatalogSnapshot {
  const snapshot = new Map(params.seed);
  for (const upstreamModel of Object.values(params.provider.models)) {
    const projected = projectUpstreamProviderCatalogModel({
      providerId: params.providerId,
      provider: params.provider,
      model: upstreamModel,
      anthropicBaseUrl: params.anthropicBaseUrl,
      defaultBaseUrl: params.defaultBaseUrl,
    });
    if (!projected) {
      continue;
    }
    const decorated = params.decorateModel ? params.decorateModel(projected) : projected;
    // SAFETY: Normalization preserves the projector's validated transport and model shape.
    const model = normalizeModelCompat(decorated) as ProjectedUpstreamProviderCatalogModel;
    const seed = params.seed.get(model.id.toLowerCase());
    const status =
      upstreamModel.status === "deprecated" || upstreamModel.status === "preview"
        ? upstreamModel.status
        : seed?.status;
    const replacedBy =
      typeof upstreamModel.replacedBy === "string" ? upstreamModel.replacedBy : seed?.replacedBy;
    // Preserve provider-owned lifecycle when upstream metadata omits it.
    snapshot.set(model.id.toLowerCase(), {
      model,
      ...(status ? { status } : {}),
      ...(replacedBy ? { replacedBy } : {}),
    });
  }
  return snapshot;
}

/** Intersects advertised ids with active trusted metadata, retaining endpoint order. */
export function projectProviderCatalogSnapshotRows(
  rows: readonly unknown[],
  snapshot: ProviderCatalogSnapshot,
): ProjectedUpstreamProviderCatalogModel[] {
  const seen = new Set<string>();
  const models: ProjectedUpstreamProviderCatalogModel[] = [];
  for (const row of rows) {
    const id = readLiveModelCatalogId(row)?.toLowerCase();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const entry = snapshot.get(id);
    if (entry && !entry.status) {
      models.push(entry.model);
    }
  }
  return models;
}

export function listProviderCatalogSnapshotEntries(
  snapshot: ProviderCatalogSnapshot,
): ModelCatalogEntry[] {
  return Array.from(snapshot.values(), ({ model, status, replacedBy }) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: model.input,
    contextWindow: model.contextWindow,
    contextTokens: model.contextTokens,
    compat: model.compat,
    ...(status ? { status } : {}),
    ...(replacedBy ? { replacedBy } : {}),
  }));
}
