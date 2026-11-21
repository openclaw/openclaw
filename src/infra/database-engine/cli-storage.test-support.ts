import path from "node:path";
import type pg from "pg";
import { expect } from "vitest";
import { listDirectoryTreeStrict } from "../directory-walk.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";

// Credentials and safety journals stay local; application stores are anchors only.
const localStores = new Map([
  [
    path.join("state", "openclaw-quarantine.sqlite"),
    ["agent_integrity_verifications", "quarantined_databases"],
  ],
  [
    path.join("control", "services.sqlite"),
    ["daemon_runtime_pin_migration", "daemon_runtime_pins"],
  ],
  [
    path.join("client", "credentials.sqlite"),
    [
      "client_credential_migration",
      "device_auth_tokens",
      "device_identities",
      "gateway_origin_device_tokens",
      "native_exec_socket_credentials",
    ],
  ],
]);

export async function cliSqliteFiles(stateDir: string) {
  return (await listDirectoryTreeStrict(stateDir))
    .map((entry) => entry.relativePath)
    .filter((file) => file.endsWith(".sqlite"));
}

export function inspectPostgresCliStore(database: string, stateDir: string, label: string) {
  using db = openNodeSqliteDatabase(database, { readOnly: true });
  const relative = path.relative(stateDir, database);
  const local = localStores.get(relative);
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
    `${label} left application tables in ${relative}`,
  ).toEqual((local ?? ["openclaw_engine_anchor"]).map((name) => ({ name })));
  if (local) {
    if (relative === path.join("client", "credentials.sqlite")) {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    }
    return undefined;
  }
  const identity = db.prepare("SELECT engine, schema FROM openclaw_engine_anchor").get();
  expect(identity?.engine).toBe("postgres");
  return String(identity?.schema);
}

export async function dropCliSchemas(client: pg.Client, prefix: string) {
  const schemas = await client.query<{ schema_name: string }>(
    "SELECT schema_name FROM information_schema.schemata WHERE starts_with(schema_name, $1)",
    [`${prefix}_`],
  );
  for (const { schema_name } of schemas.rows) {
    await client.query(`DROP SCHEMA "${schema_name}" CASCADE`);
  }
}
