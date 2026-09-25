import type { DatabaseSync } from "node:sqlite";

// Native identity state with the optional checkpoint tables written before canonical adoption.
export function seedNativeVersionZeroState(
  native: DatabaseSync,
  hasExistingLeaseTables: boolean,
): void {
  native.exec(`
  CREATE TABLE device_identities (
    identity_key TEXT NOT NULL PRIMARY KEY,
    device_id TEXT NOT NULL,
    public_key_pem TEXT NOT NULL,
    private_key_pem TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX idx_device_identities_device
    ON device_identities(device_id, updated_at_ms DESC);
  INSERT INTO device_identities VALUES ('node', 'native-device', 'public', 'private', 1, 1);
  CREATE TABLE exec_approvals_config (
    config_key TEXT NOT NULL PRIMARY KEY,
    raw_json TEXT NOT NULL,
    socket_path TEXT,
    has_socket_token INTEGER NOT NULL,
    default_security TEXT,
    default_ask TEXT,
    default_ask_fallback TEXT,
    auto_allow_skills INTEGER,
    agent_count INTEGER NOT NULL,
    allowlist_count INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT;
  INSERT INTO exec_approvals_config
    VALUES ('current', '{}', NULL, 0, NULL, NULL, NULL, NULL, 0, 0, 1);
`);
  if (hasExistingLeaseTables) {
    native.exec(`
    CREATE TABLE schema_meta (
      meta_key TEXT NOT NULL PRIMARY KEY,
      role TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      agent_id TEXT,
      app_version TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE state_leases (
      scope TEXT NOT NULL,
      lease_key TEXT NOT NULL,
      owner TEXT NOT NULL,
      expires_at INTEGER,
      heartbeat_at INTEGER,
      payload_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, lease_key)
    );
    CREATE INDEX idx_state_leases_expiry
      ON state_leases(expires_at, scope, lease_key)
      WHERE expires_at IS NOT NULL;
    CREATE INDEX idx_state_leases_owner
      ON state_leases(owner, updated_at DESC);
  `);
  }
}
