// Independent of the selected Gateway engine and its shared schema version.
export const CLIENT_CREDENTIAL_SCHEMA_VERSION = 1;

// These unchanged tables also describe the shared-state v25 migration source.
export const CLIENT_CREDENTIAL_LEGACY_TABLES_SQL = `CREATE TABLE device_identities (
  identity_key TEXT NOT NULL PRIMARY KEY,
  device_id TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  private_key_pem TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_device_identities_device
  ON device_identities(device_id, updated_at_ms DESC);
CREATE TABLE device_auth_tokens (
  device_id TEXT NOT NULL,
  role TEXT NOT NULL,
  token TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (device_id, role)
) STRICT;
CREATE INDEX idx_device_auth_tokens_updated
  ON device_auth_tokens(updated_at_ms DESC, device_id, role);
CREATE TABLE gateway_origin_device_tokens (
  gateway_scope TEXT NOT NULL,
  device_id TEXT NOT NULL,
  role TEXT NOT NULL,
  token TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (gateway_scope, device_id, role)
) STRICT;`;

export const CLIENT_CREDENTIAL_SCHEMA_SQL = `${CLIENT_CREDENTIAL_LEGACY_TABLES_SQL}
CREATE TABLE native_exec_socket_credentials (
  socket_key TEXT NOT NULL PRIMARY KEY CHECK (socket_key = 'current'),
  socket_path TEXT,
  socket_token TEXT,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE client_credential_migration (
  version INTEGER PRIMARY KEY CHECK (version = 1),
  source_store TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('copied', 'complete')),
  updated_at_ms INTEGER NOT NULL
) STRICT;`;

export type ClientCredentialDatabase = {
  device_identities: {
    identity_key: string;
    device_id: string;
    public_key_pem: string;
    private_key_pem: string;
    created_at_ms: number;
    updated_at_ms: number;
  };
  device_auth_tokens: {
    device_id: string;
    role: string;
    token: string;
    scopes_json: string;
    updated_at_ms: number;
  };
  gateway_origin_device_tokens: ClientCredentialDatabase["device_auth_tokens"] & {
    gateway_scope: string;
  };
  native_exec_socket_credentials: {
    socket_key: "current";
    socket_path: string | null;
    socket_token: string | null;
    updated_at_ms: number;
  };
  client_credential_migration: {
    version: 1;
    source_store: string;
    phase: "copied" | "complete";
    updated_at_ms: number;
  };
};
