import type { DatabaseEngineId } from "./types.js";

export class DatabaseSearchCapabilityUnavailableError extends Error {
  readonly code = "DATABASE_SEARCH_CAPABILITY_UNAVAILABLE";

  constructor(capability: "fullText" | "vector") {
    super(
      `PostgreSQL ${capability} search is unavailable until the PostgreSQL search adapter is installed.`,
    );
    this.name = "DatabaseSearchCapabilityUnavailableError";
  }
}

export const databaseSearchCapabilities = {
  sqlite: { fullText: "fts5", vector: "sqlite-vec" },
  postgres: {
    fullText: null,
    vector: null,
    diagnostic:
      "PostgreSQL search is unavailable until the PostgreSQL search adapter is installed.",
  },
} as const;

export function requireDatabaseSearchCapability(
  engine: DatabaseEngineId,
  capability: "fullText" | "vector",
): void {
  if (databaseSearchCapabilities[engine][capability] === null) {
    throw new DatabaseSearchCapabilityUnavailableError(capability);
  }
}
