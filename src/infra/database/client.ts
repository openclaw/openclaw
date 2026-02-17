/**
 * PostgreSQL client for OpenClaw metrics storage.
 * Uses postgres.js for connection management.
 * Works with PostgreSQL/TimescaleDB from Docker, Homebrew, or any external source.
 */

import postgres from "postgres";

export type DatabaseConfig = {
  /** Full connection URL if provided (preferred). */
  url?: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  maxConnections?: number;
  idleTimeout?: number;
  connectTimeout?: number;
  ssl?: boolean;
};

let sql: postgres.Sql | null = null;

function parseDatabaseUrl(raw: string): DatabaseConfig | null {
  try {
    const url = new URL(raw);
    // Accept: postgres:// and postgresql://
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      return null;
    }
    const host = url.hostname || "localhost";
    const port = url.port ? Number(url.port) : 5432;
    const database = url.pathname.replace(/^\//, "") || "openclaw";
    const username = decodeURIComponent(url.username || "openclaw");
    const password = decodeURIComponent(url.password || "openclaw");
    const sslmode = (url.searchParams.get("sslmode") || "").toLowerCase();
    const ssl = sslmode === "require" || sslmode === "verify-ca" || sslmode === "verify-full";
    return {
      url: raw,
      host,
      port,
      database,
      username,
      password,
      ssl,
    };
  } catch {
    return null;
  }
}

export function getDatabaseConfig(): DatabaseConfig {
  const urlConfig = process.env.DATABASE_URL?.trim()
    ? parseDatabaseUrl(process.env.DATABASE_URL.trim())
    : null;
  if (urlConfig) {
    return {
      ...urlConfig,
      maxConnections: Number(process.env.POSTGRES_MAX_CONNECTIONS ?? 10),
      idleTimeout: Number(process.env.POSTGRES_IDLE_TIMEOUT ?? 30),
      connectTimeout: Number(process.env.POSTGRES_CONNECT_TIMEOUT ?? 10),
    };
  }

  return {
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    database: process.env.POSTGRES_DB ?? "openclaw",
    username: process.env.POSTGRES_USER ?? "openclaw",
    password: process.env.POSTGRES_PASSWORD ?? "openclaw",
    maxConnections: Number(process.env.POSTGRES_MAX_CONNECTIONS ?? 10),
    idleTimeout: Number(process.env.POSTGRES_IDLE_TIMEOUT ?? 30),
    connectTimeout: Number(process.env.POSTGRES_CONNECT_TIMEOUT ?? 10),
    ssl: process.env.POSTGRES_SSL === "true",
  };
}

export function getDatabase(): postgres.Sql {
  if (sql) {
    return sql;
  }

  const config = getDatabaseConfig();

  const options: postgres.Options<{}> = {
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    max: config.maxConnections,
    idle_timeout: config.idleTimeout,
    connect_timeout: config.connectTimeout,
    ssl: config.ssl,
    onnotice: () => {
      // Suppress notices
    },
  };

  // Prefer DATABASE_URL when present so users can use standard tooling/env.
  sql = config.url ? postgres(config.url, options) : postgres(options);

  return sql;
}

export async function closeDatabase(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
  }
}

export async function isDatabaseConnected(): Promise<boolean> {
  try {
    const db = getDatabase();
    await db`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function runMigrations(): Promise<void> {
  const db = getDatabase();

  // Create migrations tracking table
  await db`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Get applied migrations
  const applied = await db<{ name: string }[]>`
    SELECT name FROM migrations ORDER BY id
  `;
  const appliedNames = new Set(applied.map((m) => m.name));

  // Define migrations in order
  const migrations: { name: string; up: string }[] = [
    {
      name: "001_create_llm_usage",
      up: `
        CREATE TABLE IF NOT EXISTS llm_usage (
          time TIMESTAMPTZ NOT NULL,
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          agent_id TEXT,
          session_id TEXT,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER DEFAULT 0,
          cache_write_tokens INTEGER DEFAULT 0,
          cost_usd DECIMAL(10,6),
          duration_ms INTEGER
        );

        -- Only create hypertable if TimescaleDB extension is available
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
            PERFORM create_hypertable('llm_usage', 'time', if_not_exists => TRUE);
          END IF;
        END $$;

        CREATE INDEX IF NOT EXISTS idx_usage_provider ON llm_usage (provider_id, time DESC);
        CREATE INDEX IF NOT EXISTS idx_usage_model ON llm_usage (model_id, time DESC);
        CREATE INDEX IF NOT EXISTS idx_usage_agent ON llm_usage (agent_id, time DESC) WHERE agent_id IS NOT NULL;
      `,
    },
    {
      name: "002_create_usage_hourly_view",
      up: `
        -- Create continuous aggregate for hourly stats (TimescaleDB only)
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
            CREATE MATERIALIZED VIEW IF NOT EXISTS llm_usage_hourly
            WITH (timescaledb.continuous) AS
            SELECT
              time_bucket('1 hour', time) AS bucket,
              provider_id,
              model_id,
              COUNT(*) AS requests,
              SUM(input_tokens) AS total_input_tokens,
              SUM(output_tokens) AS total_output_tokens,
              SUM(cache_read_tokens) AS total_cache_read_tokens,
              SUM(cache_write_tokens) AS total_cache_write_tokens,
              SUM(cost_usd) AS total_cost
            FROM llm_usage
            GROUP BY bucket, provider_id, model_id
            WITH NO DATA;
          END IF;
        END $$;
      `,
    },
    {
      name: "003_create_security_events",
      up: `
        CREATE TABLE IF NOT EXISTS security_events (
          time TIMESTAMPTZ NOT NULL,
          event_id TEXT NOT NULL,
          category TEXT NOT NULL,
          severity TEXT NOT NULL,
          action TEXT NOT NULL,
          description TEXT,
          source TEXT,
          session_key TEXT,
          agent_id TEXT,
          user_id TEXT,
          ip_address TEXT,
          channel TEXT,
          blocked BOOLEAN DEFAULT FALSE,
          metadata JSONB,
          PRIMARY KEY (time, event_id)
        );

        -- TimescaleDB hypertable if available
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
            PERFORM create_hypertable('security_events', 'time', if_not_exists => TRUE);
          END IF;
        END $$;

        CREATE INDEX IF NOT EXISTS idx_security_category ON security_events (category, time DESC);
        CREATE INDEX IF NOT EXISTS idx_security_severity ON security_events (severity, time DESC);
        CREATE INDEX IF NOT EXISTS idx_security_session ON security_events (session_key, time DESC) WHERE session_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_security_ip ON security_events (ip_address, time DESC) WHERE ip_address IS NOT NULL;

        -- Compression policy for TimescaleDB (compress after 7 days)
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
            ALTER TABLE security_events SET (
              timescaledb.compress,
              timescaledb.compress_segmentby = 'category,severity'
            );
            PERFORM add_compression_policy('security_events', INTERVAL '7 days', if_not_exists => TRUE);
          END IF;
        END $$;
      `,
    },
    {
      name: "004_create_auth_credentials",
      up: `
        CREATE TABLE IF NOT EXISTS auth_credentials (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          profile_id TEXT NOT NULL UNIQUE,
          provider TEXT NOT NULL,
          credential_type TEXT NOT NULL,
          encrypted_data TEXT NOT NULL,
          iv TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          key_version INTEGER NOT NULL DEFAULT 1,
          email TEXT,
          expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_auth_creds_provider ON auth_credentials (provider);
        CREATE INDEX IF NOT EXISTS idx_auth_creds_type ON auth_credentials (credential_type);
        CREATE INDEX IF NOT EXISTS idx_auth_creds_expires ON auth_credentials (expires_at) WHERE expires_at IS NOT NULL;

        CREATE TABLE IF NOT EXISTS auth_usage_stats (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          profile_id TEXT NOT NULL UNIQUE REFERENCES auth_credentials(profile_id) ON DELETE CASCADE,
          last_used TIMESTAMPTZ,
          error_count INTEGER DEFAULT 0,
          last_failure_at TIMESTAMPTZ,
          failure_counts JSONB DEFAULT '{}',
          cooldown_until TIMESTAMPTZ,
          disabled_until TIMESTAMPTZ,
          disabled_reason TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_auth_usage_profile ON auth_usage_stats (profile_id);

        CREATE TABLE IF NOT EXISTS auth_store_meta (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `,
    },
  ];

  // Apply pending migrations
  for (const migration of migrations) {
    if (!appliedNames.has(migration.name)) {
      await db.unsafe(migration.up);
      await db`INSERT INTO migrations (name) VALUES (${migration.name})`;
    }
  }
}

export { postgres };
