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
