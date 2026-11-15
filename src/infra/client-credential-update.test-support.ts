import { expect } from "vitest";
import { readClientCredentialReceipt } from "./client-credential-readiness.js";
import { openClientCredentialCustody } from "./client-credential-store.js";
import { generateStoredDeviceIdentity } from "./device-identity-material.js";
import type { EngineConnection } from "./sql-connection.js";

export const identity = generateStoredDeviceIdentity(12);

export const policy = {
  version: 1,
  socket: { path: "/synthetic/native.sock", token: "synthetic-socket-token", future: "keep" },
  defaults: { security: "allowlist", ask: "on-miss" },
  agents: {},
};

export function seedCredentials(
  db: EngineConnection,
  native: boolean,
  sourceVersion: 25 | 26 | 27 | 28,
) {
  db.prepare("INSERT INTO device_identities VALUES (?, ?, ?, ?, ?, ?)").run(
    "primary",
    identity.deviceId,
    identity.publicKeyPem,
    identity.privateKeyPem,
    12,
    99,
  );
  db.prepare("INSERT INTO device_auth_tokens VALUES (?, ?, ?, ?, ?)").run(
    identity.deviceId,
    "operator",
    "synthetic-original-token",
    '[ "operator.read" ]',
    101,
  );
  if (native) {
    return;
  }
  db.prepare("INSERT INTO gateway_origin_device_tokens VALUES (?, ?, ?, ?, ?, ?)").run(
    "https://synthetic.invalid",
    identity.deviceId,
    "operator",
    "synthetic-origin-token",
    '["operator.write"]',
    102,
  );
  db.prepare("INSERT INTO exec_approvals_config VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "current",
    JSON.stringify(policy),
    policy.socket.path,
    1,
    "allowlist",
    "on-miss",
    null,
    null,
    0,
    0,
    104,
  );
  db.prepare(
    "INSERT INTO schema_meta VALUES ('primary', 'global', ?, NULL, 'fixture', 123, 123)",
  ).run(sourceVersion);
  db.prepare("INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', ?, 1)").run(
    String(sourceVersion),
  );
}

export function assertMigratedCredentials(f: { env: NodeJS.ProcessEnv; native: boolean }) {
  using local = openClientCredentialCustody(f.env, { migration: true })!;
  expect(readClientCredentialReceipt(local.database)?.phase).toBe("complete");
  expect(local.database.prepare("SELECT * FROM device_identities").get()).toEqual({
    identity_key: "primary",
    device_id: identity.deviceId,
    public_key_pem: identity.publicKeyPem,
    private_key_pem: identity.privateKeyPem,
    created_at_ms: 12,
    updated_at_ms: 99,
  });
  expect(local.database.prepare("SELECT token FROM device_auth_tokens").get()).toEqual({
    token: "synthetic-original-token",
  });
  if (!f.native) {
    expect(
      local.database
        .prepare("SELECT socket_path,socket_token FROM native_exec_socket_credentials")
        .get(),
    ).toEqual({
      socket_path: "/synthetic/native.sock",
      socket_token: "synthetic-socket-token",
    });
  }
}
