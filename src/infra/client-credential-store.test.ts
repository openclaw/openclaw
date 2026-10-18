import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolveClientCredentialStorePath,
  runClientCredentialOperation,
  withClientCredentialStore,
  type ClientIdentityRecord,
  type ClientTokenRecord,
} from "./client-credential-store.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
function fixture() {
  const root = dirs.make("client-credential-owner-");
  const env = { OPENCLAW_STATE_DIR: root };
  return {
    root,
    env,
    run: (operation: Parameters<typeof runClientCredentialOperation>[1]) =>
      runClientCredentialOperation(env, operation),
  };
}

const identity: ClientIdentityRecord = {
  identity_key: "node",
  device_id: "synthetic-device",
  public_key_pem: "synthetic-public-pem\n",
  private_key_pem: "synthetic-private-pem\n",
  created_at_ms: 123,
  updated_at_ms: 456,
};
const token: ClientTokenRecord = {
  device_id: identity.device_id,
  role: "v2.named-gateway.operator",
  token: "synthetic-cached-token",
  scopes_json: '[ "operator.read", "operator.write" ]',
  updated_at_ms: 789,
};

it("keeps read-existing credential operations local and does not bootstrap missing state", () => {
  const { root, run } = fixture();
  expect(run({ kind: "identity.read", identity_key: "primary" })).toEqual({
    kind: "identity",
    identity: null,
  });
  expect(run({ kind: "token.read", key: token })).toEqual({ kind: "token", token: null });
  expect(run({ kind: "socket.read" })).toEqual({ kind: "socket", socket: null });
  expect(run({ kind: "token.remove", key: token, expectedToken: token.token })).toEqual({
    kind: "changed",
    changed: false,
  });
  expect(fs.readdirSync(root)).toEqual([]);
});

it("returns the durable first identity without replacing its exact key material or timestamps", () => {
  const { root, env, run } = fixture();
  expect(run({ kind: "identity.create", identity })).toEqual({ kind: "identity", identity });
  expect(
    run({
      kind: "identity.create",
      identity: { ...identity, private_key_pem: "competing-candidate", updated_at_ms: 999 },
    }),
  ).toEqual({ kind: "identity", identity });
  expect(run({ kind: "identity.read", identity_key: "node" })).toEqual({
    kind: "identity",
    identity,
  });
  expect(run({ kind: "identity.read", identity_key: "primary" })).toEqual({
    kind: "identity",
    identity: null,
  });
  expect(fs.existsSync(path.join(root, "state"))).toBe(false);
  expect(fs.statSync(resolveClientCredentialStorePath(env)).mode & 0o077).toBe(0);
});

it("separates gateway caches and rejects stale token refresh and revocation observations", () => {
  const { run } = fixture();
  const local = { device_id: token.device_id, role: token.role };
  const remote = { ...local, gateway_scope: "wss://synthetic-gateway.invalid" };
  expect(run({ kind: "token.replace", key: local, token, expectedToken: null })).toEqual({
    kind: "changed",
    changed: true,
  });
  const scoped = { ...token, token: "synthetic-scoped-token" };
  expect(run({ kind: "token.replace", key: remote, token: scoped, expectedToken: null })).toEqual({
    kind: "changed",
    changed: true,
  });
  const refreshed = { ...token, token: "synthetic-refreshed-token", updated_at_ms: 900 };
  expect(
    run({ kind: "token.replace", key: local, token: refreshed, expectedToken: token.token }),
  ).toEqual({ kind: "changed", changed: true });
  expect(run({ kind: "token.replace", key: local, token, expectedToken: token.token })).toEqual({
    kind: "changed",
    changed: false,
  });
  expect(run({ kind: "token.remove", key: local, expectedToken: token.token })).toEqual({
    kind: "changed",
    changed: false,
  });
  expect(run({ kind: "token.read", key: local })).toEqual({ kind: "token", token: refreshed });
  expect(run({ kind: "token.remove", key: local, expectedToken: refreshed.token })).toEqual({
    kind: "changed",
    changed: true,
  });
  expect(run({ kind: "token.read", key: local })).toEqual({ kind: "token", token: null });
  expect(run({ kind: "token.read", key: remote })).toEqual({ kind: "token", token: scoped });
});

it("stores native socket material without creating or changing shared policy", () => {
  const { root, run } = fixture();
  const socket = {
    socket_key: "current" as const,
    socket_path: "/synthetic/exec.sock",
    socket_token: "synthetic-socket-token",
    updated_at_ms: 23,
  };
  expect(run({ kind: "socket.create", socket })).toEqual({ kind: "socket", socket });
  expect(
    run({ kind: "socket.create", socket: { ...socket, socket_token: "replacement" } }),
  ).toEqual({ kind: "socket", socket });
  expect(run({ kind: "socket.read" })).toEqual({ kind: "socket", socket });
  expect(
    run({
      kind: "socket.replace",
      socket: { ...socket, socket_token: null },
      expectedToken: socket.socket_token,
    }),
  ).toEqual({ kind: "changed", changed: true });
  expect(run({ kind: "socket.replace", socket, expectedToken: null })).toEqual({
    kind: "changed",
    changed: true,
  });
  expect(
    run({
      kind: "socket.replace",
      socket: { ...socket, socket_token: "stale" },
      expectedToken: null,
    }),
  ).toEqual({ kind: "changed", changed: false });
  expect(run({ kind: "socket.read" })).toEqual({ kind: "socket", socket });
  expect(fs.existsSync(path.join(root, "state", "openclaw.sqlite"))).toBe(false);
});

it("refuses newer local schemas without reopening or modifying shared state", () => {
  const { env } = fixture();
  withClientCredentialStore(env, true, (db) => db.exec("PRAGMA user_version=2"));
  expect(() =>
    runClientCredentialOperation(env, { kind: "identity.read", identity_key: "primary" }),
  ).toThrow("unsupported schema version 2");
  using db = openNodeSqliteDatabase(resolveClientCredentialStorePath(env), { readOnly: true });
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
});

it.runIf(process.platform === "darwin")(
  "rejects ACL access to existing private credentials",
  () => {
    const { env, run } = fixture();
    run({ kind: "identity.create", identity });
    const pathname = resolveClientCredentialStorePath(env);
    execFileSync("/bin/chmod", ["+a", "everyone allow read", pathname]);
    expect(() => run({ kind: "identity.read", identity_key: identity.identity_key })).toThrow(
      "without ACL entries",
    );
    execFileSync("/bin/chmod", ["-N", pathname]);
  },
);

it.runIf(process.platform !== "win32")(
  "rejects a credential directory accessible to other users",
  () => {
    const { env, run } = fixture();
    run({ kind: "identity.create", identity });
    const directory = path.dirname(resolveClientCredentialStorePath(env));
    fs.chmodSync(directory, 0o777);
    expect(() => run({ kind: "identity.read", identity_key: identity.identity_key })).toThrow(
      "directory is unsafe",
    );
    fs.chmodSync(directory, 0o700);
  },
);
