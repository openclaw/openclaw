export type ProviderCatalogOutcome = {
  provider: string;
  /** Auth profile tested by discovery; omission means provider-wide auth. */
  profileId?: string;
  /** Limits an auth rejection to catalog discovery rather than model execution. */
  rejectionScope?: "catalog";
  status: "ready" | "auth-rejected" | "unavailable";
  /**
   * Published model ids the provider omitted from this credential's live catalog.
   * The rows stay listed for discovery, but the tested credential cannot run them.
   */
  unlistedModelIds?: readonly string[];
};
