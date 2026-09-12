import type {
  ManifestModelIdNormalizationProvider,
  ManifestModelIdNormalizationRecord,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";

/** Caller-owned declarations or facts from an already selected metadata snapshot. */
export type ManifestModelIdNormalizationSource =
  | readonly ManifestModelIdNormalizationRecord[]
  | {
      owners: {
        modelIdNormalizationPolicies: ReadonlyMap<string, ManifestModelIdNormalizationProvider>;
      };
    };
