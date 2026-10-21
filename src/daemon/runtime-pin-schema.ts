export const DAEMON_RUNTIME_PIN_SCHEMA_SQL = `CREATE TABLE daemon_runtime_pins (
  state_key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE daemon_runtime_pin_migration (
  version INTEGER PRIMARY KEY CHECK (version = 1),
  source_state TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('copied', 'complete')),
  updated_at INTEGER NOT NULL
) STRICT;`;
