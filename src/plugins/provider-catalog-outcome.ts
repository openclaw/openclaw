export type ProviderCatalogOutcome = {
  provider: string;
  /** Auth profile tested by discovery; omission means provider-wide auth. */
  profileId?: string;
  /** Limits an auth rejection to catalog discovery rather than model execution. */
  rejectionScope?: "catalog";
  status: "ready" | "auth-rejected" | "unavailable";
  /** Private account-scoped observations from successful discovery, never static model hints. */
  modelServiceTiers?: readonly {
    modelId: string;
    runtimeId: string;
    api: string;
    baseUrl: string;
    serviceTiers: readonly string[];
  }[];
  /** Optional successful discovery order for models already present in the catalog. */
  modelOrder?: readonly string[];
  /**
   * Private provenance: every model id a successful account listing returned, including hidden
   * rows; never projected publicly. Subscription routes for other ids are not entitled.
   */
  listedModelIds?: readonly string[];
  /** Private successful server listing for config advisories, independent of entitlement. */
  modelIdCatalog?: {
    baseUrl: string;
    modelIds: readonly string[];
    /** Provider-owned matching data, such as variant aliases omitted from picker rows. */
    aliases?: readonly string[];
  };
  /** Advisory only: configured ids absent from this successful server listing; never eligibility. */
  unlistedConfiguredModelIds?: readonly string[];
};
