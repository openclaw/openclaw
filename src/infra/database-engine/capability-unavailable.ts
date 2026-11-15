export class DatabaseSearchCapabilityUnavailableError extends Error {
  readonly code = "DATABASE_SEARCH_CAPABILITY_UNAVAILABLE";

  constructor(
    readonly capability: "fullText" | "vector",
    diagnostic?: string,
  ) {
    super(diagnostic ?? `Database ${capability} search capability is unavailable.`);
    this.name = "DatabaseSearchCapabilityUnavailableError";
  }
}
