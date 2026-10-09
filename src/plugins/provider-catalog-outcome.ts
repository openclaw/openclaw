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
};
