import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  performClientCredentialOperation,
  type ClientIdentityRecord,
} from "./client-credential-operations.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import { writeClientCredentialReceipt } from "./client-credential-readiness.js";
import {
  emptyClientCredentialReceipt,
  readClientCredentialFileIdentity,
} from "./client-credential-receipt.js";
import {
  openClientCredentialCustody,
  isClientCredentialBusyError,
  runClientCredentialOperation,
  type ClientTokenRecord,
} from "./client-credential-store.js";
import { withClientCredentialStore } from "./client-credential-store.test-support.js";
import {
  generateStoredDeviceIdentity,
  storedDeviceIdentityToRow,
} from "./device-identity-material.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { thrownBy } from "./sqlite-maintenance-fixture.test-support.js";

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

const identity: ClientIdentityRecord = storedDeviceIdentityToRow(
  "node",
  generateStoredDeviceIdentity(123),
  456,
);
const token: ClientTokenRecord = {
  device_id: identity.device_id,
  role: "v2.named-gateway.operator",
  token: "synthetic-cached-token",
  scopes_json: '[ "operator.read", "operator.write" ]',
  updated_at_ms: 789,
};

it("reports store creation for rollback attribution without claiming an existing store", () => {
  const { env } = fixture();
  {
    using first = openClientCredentialCustody(env, { createIfMissing: true, migration: true });
    expect(first?.created).toBe(true);
  }
  using reopened = openClientCredentialCustody(env, { createIfMissing: true, migration: true });
  expect(reopened?.created).toBe(false);
  expect(fs.statSync(resolveClientCredentialStorePath(env)).mode & 0o077).toBe(0);
});

it.each(["./../state/openclaw.sqlite", "./state//openclaw.sqlite", "./state\\openclaw.sqlite"])(
  "refuses an unsafe relative receipt binding: %s",
  (binding) => {
    const { env } = fixture();
    {
      using owner = openClientCredentialCustody(env, { createIfMissing: true, migration: true })!;
      owner.database
        .prepare("INSERT INTO client_credential_migration VALUES (1, ?, 'complete', 0)")
        .run(JSON.stringify(emptyClientCredentialReceipt({ path: binding, dev: "1", ino: "2" })));
    }
    expect(() =>
      runClientCredentialOperation(env, { kind: "identity.read", identity_key: "primary" }),
    ).toThrow("invalid relative shared binding");
  },
);

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

it.each(["-wal", "-shm", "-journal"])(
  "refuses fresh credentials when only shared %s survives",
  (suffix) => {
    const { root, env, run } = fixture();
    const shared = path.join(root, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(shared));
    const sidecar = `${shared}${suffix}`;
    const original = Buffer.from("synthetic retained SQLite family bytes");
    fs.writeFileSync(sidecar, original);
    expect(() => run({ kind: "identity.read", identity_key: "node" })).toThrow(
      "restore the matching main database",
    );
    expect(() => run({ kind: "identity.create", identity })).toThrow(
      "restore the matching main database",
    );
    expect(fs.existsSync(resolveClientCredentialStorePath(env))).toBe(false);
    expect(fs.readdirSync(path.dirname(shared))).toEqual([path.basename(sidecar)]);
    expect(fs.readFileSync(sidecar)).toEqual(original);
  },
);

it("stores native socket material without creating or changing shared policy", () => {
  const { root, run } = fixture();
  const socket = {
    socket_key: "current" as const,
    socket_path: path.join(root, "exec-approvals.sock"),
    socket_token: "synthetic-socket-token",
    updated_at_ms: 23,
  };
  expect(run({ kind: "socket.ensure", fallback: socket })).toEqual({ kind: "socket", socket });
  const migrated = { ...socket, socket_path: "/synthetic/current.sock", updated_at_ms: 99 };
  expect(
    run({
      kind: "socket.ensure",
      fallback: { ...migrated, socket_token: "discarded" },
    }),
  ).toEqual({ kind: "socket", socket: migrated });
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

it("retains exclusive custody across commits and rejects overlapping local owners", () => {
  const { env, run } = fixture();
  run({ kind: "identity.create", identity });
  using owner = openClientCredentialCustody(env, { readOnly: true });
  expect(owner).toBeDefined();
  expect(() => openClientCredentialCustody(env)).toThrowError(
    expect.objectContaining({ name: "ClientCredentialBusyError" }),
  );
  using other = openNodeSqliteDatabase(resolveClientCredentialStorePath(env), { timeout: 0 });
  expect(isClientCredentialBusyError(thrownBy(() => other.exec("BEGIN IMMEDIATE")))).toBe(true);
  expect(owner!.run({ kind: "identity.read", identity_key: identity.identity_key })).toEqual({
    kind: "identity",
    identity,
  });
  expect(() => other.exec("BEGIN IMMEDIATE")).toThrow("locked");
  owner!.close();
  other.exec("BEGIN IMMEDIATE; ROLLBACK");
});

it("refuses missing, incomplete and replaced-source receipts without opening shared state", () => {
  const { root, env, run } = fixture();
  fs.mkdirSync(path.join(root, "state"));
  const shared = path.join(root, "state", "openclaw.sqlite");
  fs.writeFileSync(shared, "this is deliberately not SQLite");
  expect(() => run({ kind: "identity.create", identity })).toThrow(
    "migration is incomplete or stale",
  );
  expect(fs.existsSync(resolveClientCredentialStorePath(env))).toBe(false);
  withClientCredentialStore(env, true, (db) =>
    writeClientCredentialReceipt(db, emptyClientCredentialReceipt(), "copied"),
  );
  expect(() => run({ kind: "identity.read", identity_key: "node" })).toThrow(
    "migration is incomplete or stale",
  );
  withClientCredentialStore(env, false, (db) =>
    writeClientCredentialReceipt(db, emptyClientCredentialReceipt(), "complete"),
  );
  expect(() => run({ kind: "identity.read", identity_key: "node" })).toThrow(
    "migration is incomplete or stale",
  );
  withClientCredentialStore(env, false, (db) =>
    writeClientCredentialReceipt(
      db,
      emptyClientCredentialReceipt(readClientCredentialFileIdentity(shared)),
      "complete",
    ),
  );
  expect(run({ kind: "identity.read", identity_key: "node" })).toEqual({
    kind: "identity",
    identity: null,
  });
  const replacement = path.join(root, "state", "replacement.sqlite");
  fs.writeFileSync(replacement, "this is deliberately not SQLite");
  fs.renameSync(replacement, shared);
  expect(() => run({ kind: "identity.read", identity_key: "node" })).toThrow(
    "migration is incomplete or stale",
  );
  expect(fs.readFileSync(shared, "utf8")).toBe("this is deliberately not SQLite");
});

it("pages tokens in stable role order and preserves existing scoped claims", () => {
  const { run } = fixture();
  for (const role of ["z", "a", "m"]) {
    run({ kind: "token.replace", key: { ...token, role }, token: { ...token, role } });
  }
  expect(run({ kind: "token.list", device_id: token.device_id, limit: 2 })).toMatchObject({
    kind: "tokens",
    tokens: [{ role: "a" }, { role: "m" }],
    nextRole: "m",
  });
  expect(
    run({ kind: "token.list", device_id: token.device_id, afterRole: "m", limit: 2 }),
  ).toMatchObject({ tokens: [{ role: "z" }], nextRole: null });
  const scopedRole = "v2.c3ludGhldGljLWdhdGV3YXk.YQ";
  run({
    kind: "token.replace",
    key: { ...token, role: scopedRole },
    token: { ...token, role: scopedRole, token: "scoped-winner" },
  });
  run({ kind: "native.tokens.clear", device_id: token.device_id, selector: { kind: "unscoped" } });
  expect(run({ kind: "token.list", device_id: token.device_id })).toMatchObject({
    tokens: [{ role: scopedRole }],
  });
  run({
    kind: "native.tokens.clear",
    device_id: token.device_id,
    selector: { kind: "gateway", gateway: "synthetic-gateway" },
  });
  expect(run({ kind: "token.list", device_id: token.device_id })).toEqual({
    kind: "tokens",
    tokens: [],
    nextRole: null,
  });
});

it("repairs identity metadata without changing key material or the requested timestamp", () => {
  const { env, run } = fixture();
  run({ kind: "identity.create", identity });
  withClientCredentialStore(env, false, (db) =>
    db
      .prepare("UPDATE device_identities SET device_id = ? WHERE identity_key = ?")
      .run("damaged", identity.identity_key),
  );
  expect(() => run({ kind: "identity.create", identity })).toThrow(
    "invalid persisted device identity",
  );
  const repaired = { ...identity, updated_at_ms: 999 };
  expect(run({ kind: "identity.repair", identity: repaired })).toEqual({
    kind: "identityRepair",
    identity: repaired,
    repaired: true,
    rotated: false,
  });
});

it("requires Doctor for pending legacy files while an existing canonical identity remains usable", () => {
  const { root, env, run } = fixture();
  const identityRoot = path.join(root, "identity");
  fs.mkdirSync(identityRoot);
  const legacy = path.join(identityRoot, "node-device.json.native-importing");
  fs.writeFileSync(legacy, "synthetic pending claim");
  expect(() => run({ kind: "identity.create", identity })).toThrow(
    "Legacy client credentials require migration",
  );
  expect(fs.existsSync(resolveClientCredentialStorePath(env))).toBe(false);
  withClientCredentialStore(env, true, (db) => {
    performClientCredentialOperation(db, { kind: "identity.create", identity }, root);
    writeClientCredentialReceipt(db, emptyClientCredentialReceipt(), "complete");
  });
  expect(run({ kind: "identity.read", identity_key: "node" })).toEqual({
    kind: "identity",
    identity,
  });
});

it("does not create a read-only store and refuses writes through retained read-only custody", () => {
  const { root, env, run } = fixture();
  expect(
    openClientCredentialCustody(env, { createIfMissing: true, readOnly: true }),
  ).toBeUndefined();
  expect(() =>
    runClientCredentialOperation(env, { kind: "identity.create", identity }, { readOnly: true }),
  ).toThrow("read-only");
  expect(fs.readdirSync(root)).toEqual([]);
  run({ kind: "identity.create", identity });
  using owner = openClientCredentialCustody(env, { readOnly: true });
  expect(() => owner!.run({ kind: "identity.create", identity })).toThrow("read-only");
  expect(owner!.run({ kind: "identity.read", identity_key: "node" })).toEqual({
    kind: "identity",
    identity,
  });
});

it("rolls back a cancelled operation before publishing new credential material", () => {
  const { env, run } = fixture();
  expect(() =>
    runClientCredentialOperation(
      env,
      { kind: "token.replace", key: token, token },
      {
        beforeCommit() {
          throw new Error("request cancelled");
        },
      },
    ),
  ).toThrow("request cancelled");
  expect(run({ kind: "token.read", key: token })).toEqual({ kind: "token", token: null });
});

it.runIf(process.platform !== "win32")(
  "creates through a state-root alias and keeps one credential owner through the real root",
  () => {
    const { root, env } = fixture();
    const alias = path.join(root, "root-alias");
    fs.symlinkSync(root, alias, "dir");
    {
      using owner = openClientCredentialCustody(
        { OPENCLAW_STATE_DIR: alias },
        { createIfMissing: true },
      );
      owner!.run({ kind: "identity.create", identity });
      expect(() => openClientCredentialCustody(env, { timeoutMs: 0 })).toThrowError(
        expect.objectContaining({ name: "ClientCredentialBusyError" }),
      );
    }
    expect(
      runClientCredentialOperation(env, { kind: "identity.read", identity_key: "node" }),
    ).toEqual({
      kind: "identity",
      identity,
    });
  },
);
