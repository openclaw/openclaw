import {
  validateAndSanitizeRemoteModelCatalogBundle,
  validateAndSanitizeRemoteModelCatalogBundleV2,
  validateAndSanitizeRemoteModelCatalogBundleV3,
  type RemoteModelCatalogBundle,
  type RemoteModelCatalogBundleV2,
  type RemoteModelCatalogBundleV3,
} from "@openclaw/model-catalog-core";
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type {
  ModelCatalogCost,
  ModelCatalogProvider,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type RemoteModelCatalogWireBundle =
  | RemoteModelCatalogBundle
  | RemoteModelCatalogBundleV2
  | RemoteModelCatalogBundleV3;
export type RemoteModelCatalogPrice = {
  cost: ModelCatalogCost;
  explicit: boolean;
  source?: string;
};
/**
 * Upstream vendor/model rates in source priority order. Direct lookups use the first;
 * passthrough providers use the first whose source their policy allows.
 */
export type RemoteModelCatalogUpstreamPrice = {
  rates: Array<{ source: string; cost: ModelCatalogCost }>;
  passthroughOnly: boolean;
};

/** Configured v1 mirrors remain a public input contract; runtime uses one projection. */
export function parseRemoteModelCatalogWireBundle(value: unknown): RemoteModelCatalogWireBundle {
  if (isRecord(value) && value.schemaVersion === 3) {
    return validateAndSanitizeRemoteModelCatalogBundleV3(value);
  }
  return isRecord(value) && value.schemaVersion === 2
    ? validateAndSanitizeRemoteModelCatalogBundleV2(value)
    : validateAndSanitizeRemoteModelCatalogBundle(value);
}

export function projectRemoteModelCatalog(bundle: RemoteModelCatalogWireBundle): {
  providers: Record<string, ModelCatalogProvider>;
  pricing: Record<string, RemoteModelCatalogPrice>;
  upstreamPricing: Record<string, RemoteModelCatalogUpstreamPrice>;
} {
  if (bundle.schemaVersion === 1) {
    return {
      providers: bundle.providers,
      pricing: Object.fromEntries(
        Object.entries(bundle.pricing ?? {}).map(([key, cost]) => [key, { cost, explicit: false }]),
      ),
      upstreamPricing: {},
    };
  }
  const providers: Record<string, ModelCatalogProvider> = Object.fromEntries(
    Object.entries(bundle.providers).map(([id, provider]) => [id, { ...provider, models: [] }]),
  );
  // A model row owns its key whatever its status: a mirror's standalone or upstream rate
  // must not price an unknown or withdrawn row directly. Upstream rates for row keys stay
  // available to gateways passing the vendor's model through. Provider-owned standalone
  // rates keep v1 semantics: zero needs authoritative owner policy.
  const rowKeys = new Set(
    bundle.models.map(({ provider, id }) => buildModelCatalogRef(provider, id)),
  );
  const prices: Array<[string, RemoteModelCatalogPrice]> = Object.entries(
    bundle.providerPricing ?? {},
  )
    .filter(([key]) => !rowKeys.has(key))
    .map(([key, { source, ...cost }]) => [key, { cost, explicit: false, source }]);
  for (const { provider, pricing, ...model } of bundle.models) {
    let cost: ModelCatalogCost | undefined;
    if (pricing.status === "known") {
      const {
        status: _status,
        currency: _currency,
        unit: _unit,
        source: _source,
        ...rates
      } = pricing;
      cost = rates;
      prices.push([buildModelCatalogRef(provider, model.id), { cost, explicit: true }]);
    }
    // Keep unknown/withdrawn rows: replacing the manifest row also withdraws its stale cost.
    // SAFETY: the v2 schema requires every model provider to be declared in bundle.providers.
    providers[provider]!.models.push({ ...model, ...(cost ? { cost } : {}) });
  }
  return {
    providers,
    pricing: Object.fromEntries(prices),
    upstreamPricing: Object.fromEntries(
      Object.entries(bundle.upstreamPricing ?? {}).map(
        ([key, { source, passthroughOnly = false, alternatives = [], ...cost }]) => [
          key,
          {
            rates: [
              { source, cost },
              ...alternatives.map(({ source: alternative, ...rates }) => ({
                source: alternative,
                cost: rates,
              })),
            ],
            passthroughOnly: passthroughOnly || rowKeys.has(key),
          },
        ],
      ),
    ),
  };
}
