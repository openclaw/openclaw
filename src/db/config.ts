/**
 * PostgreSQL connection configuration with test database isolation.
 * When NODE_ENV=test or VITEST is set, uses a dedicated test database
 * to prevent test data from polluting production or other environment databases.
 */

export interface PostgresConfig {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
}

/**
 * Build PostgreSQL connection configuration.
 * In test mode (NODE_ENV=test or VITEST=true), uses dedicated test database.
 */
export function buildPostgresConfig(): PostgresConfig {
  const isTestMode = process.env.NODE_ENV === "test" || process.env.VITEST === "true";

  let database = process.env.POSTGRES_DB || "openclaw";

  if (isTestMode) {
    // In test mode, use dedicated test database name (overridable via POSTGRES_TEST_DB)
    database = process.env.POSTGRES_TEST_DB || "openclaw_test";
  }

  return {
    user: process.env.POSTGRES_USER || "openclaw",
    password: process.env.POSTGRES_PASSWORD || "openclaw",
    host: process.env.POSTGRES_HOST || "localhost",
    port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
    database,
  };
}

/**
 * Get PostgreSQL connection string (useful for direct connections).
 */
export function getPostgresConnectionString(): string {
  const cfg = buildPostgresConfig();
  return `postgresql://${cfg.user}:${cfg.password}@${cfg.host}:${cfg.port}/${cfg.database}`;
}

/**
 * Check if running in test mode.
 */
export function isTestMode(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}
