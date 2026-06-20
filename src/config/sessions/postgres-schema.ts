export const OPENCLAW_SESSION_POSTGRES_SCHEMA_VERSION = 1;

export const OPENCLAW_SESSION_POSTGRES_TABLES = [
  "openclaw_session_tenants",
  "openclaw_session_gateways",
  "openclaw_session_agents",
  "openclaw_sessions",
  "openclaw_session_turns",
  "openclaw_transcript_chunks",
  "openclaw_session_leases",
  "openclaw_session_backpressure",
] as const;

export type OpenClawSessionPostgresTable = (typeof OPENCLAW_SESSION_POSTGRES_TABLES)[number];

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Invalid PostgreSQL identifier: ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export function qualifyPostgresSessionTable(
  table: OpenClawSessionPostgresTable,
  schema = "openclaw",
) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export function buildOpenClawSessionPostgresSchemaSql(schema = "openclaw"): string {
  const tenants = qualifyPostgresSessionTable("openclaw_session_tenants", schema);
  const gateways = qualifyPostgresSessionTable("openclaw_session_gateways", schema);
  const agents = qualifyPostgresSessionTable("openclaw_session_agents", schema);
  const sessions = qualifyPostgresSessionTable("openclaw_sessions", schema);
  const turns = qualifyPostgresSessionTable("openclaw_session_turns", schema);
  const chunks = qualifyPostgresSessionTable("openclaw_transcript_chunks", schema);
  const leases = qualifyPostgresSessionTable("openclaw_session_leases", schema);
  const backpressure = qualifyPostgresSessionTable("openclaw_session_backpressure", schema);
  const quotedSchema = quoteIdentifier(schema);

  return `
CREATE SCHEMA IF NOT EXISTS ${quotedSchema};

CREATE TABLE IF NOT EXISTS ${tenants} (
  tenant_id text PRIMARY KEY,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${gateways} (
  tenant_id text NOT NULL REFERENCES ${tenants}(tenant_id) ON DELETE CASCADE,
  gateway_id text NOT NULL,
  config_path text,
  state_dir text,
  session_dir text,
  process_id integer,
  event_loop_lag_ms integer,
  heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, gateway_id)
);

CREATE TABLE IF NOT EXISTS ${agents} (
  tenant_id text NOT NULL,
  gateway_id text NOT NULL,
  agent_id text NOT NULL,
  workspace_dir text,
  session_dir text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, gateway_id, agent_id),
  FOREIGN KEY (tenant_id, gateway_id) REFERENCES ${gateways}(tenant_id, gateway_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ${sessions} (
  tenant_id text NOT NULL,
  gateway_id text NOT NULL,
  agent_id text NOT NULL,
  store_path text NOT NULL,
  session_key text NOT NULL,
  session_id text,
  updated_at_ms bigint NOT NULL DEFAULT 0,
  entry_json jsonb NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, gateway_id, store_path, session_key),
  FOREIGN KEY (tenant_id, gateway_id, agent_id) REFERENCES ${agents}(tenant_id, gateway_id, agent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS openclaw_sessions_gateway_store_updated_idx
  ON ${sessions} (tenant_id, gateway_id, store_path, deleted_at, updated_at_ms DESC, session_key ASC);

CREATE INDEX IF NOT EXISTS openclaw_sessions_agent_updated_idx
  ON ${sessions} (tenant_id, gateway_id, agent_id, updated_at_ms DESC, session_key ASC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS openclaw_sessions_session_id_idx
  ON ${sessions} (tenant_id, gateway_id, session_id)
  WHERE session_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS openclaw_sessions_spawned_by_idx
  ON ${sessions} (tenant_id, gateway_id, store_path, (entry_json->>'spawnedBy'), updated_at_ms DESC, session_key ASC)
  WHERE deleted_at IS NULL AND entry_json ? 'spawnedBy';

CREATE INDEX IF NOT EXISTS openclaw_sessions_parent_key_idx
  ON ${sessions} (tenant_id, gateway_id, store_path, (entry_json->>'parentSessionKey'), updated_at_ms DESC, session_key ASC)
  WHERE deleted_at IS NULL AND entry_json ? 'parentSessionKey';

CREATE TABLE IF NOT EXISTS ${turns} (
  tenant_id text NOT NULL,
  gateway_id text NOT NULL,
  agent_id text NOT NULL,
  store_path text NOT NULL,
  session_key text NOT NULL,
  turn_seq bigint NOT NULL,
  role text NOT NULL,
  model_provider text,
  model text,
  input_tokens bigint,
  output_tokens bigint,
  started_at timestamptz,
  ended_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, gateway_id, store_path, session_key, turn_seq),
  FOREIGN KEY (tenant_id, gateway_id, store_path, session_key) REFERENCES ${sessions}(tenant_id, gateway_id, store_path, session_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ${chunks} (
  tenant_id text NOT NULL,
  gateway_id text NOT NULL,
  agent_id text NOT NULL,
  store_path text NOT NULL,
  session_key text NOT NULL,
  chunk_seq bigint NOT NULL,
  transcript_path text,
  content_sha256 text,
  bytes integer NOT NULL DEFAULT 0,
  chunk_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, gateway_id, store_path, session_key, chunk_seq),
  FOREIGN KEY (tenant_id, gateway_id, store_path, session_key) REFERENCES ${sessions}(tenant_id, gateway_id, store_path, session_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ${leases} (
  tenant_id text NOT NULL,
  gateway_id text NOT NULL,
  lease_key text NOT NULL,
  holder_id text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, gateway_id, lease_key)
);

CREATE TABLE IF NOT EXISTS ${backpressure} (
  tenant_id text NOT NULL,
  gateway_id text NOT NULL,
  lane text NOT NULL,
  admitted integer NOT NULL DEFAULT 0,
  running integer NOT NULL DEFAULT 0,
  queued integer NOT NULL DEFAULT 0,
  rejected integer NOT NULL DEFAULT 0,
  max_running integer,
  max_queued integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, gateway_id, lane)
);
`.trim();
}
