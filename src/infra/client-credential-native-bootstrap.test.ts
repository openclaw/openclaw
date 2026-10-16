import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  isNativeClientCredentialBootstrap,
  readIndependentClientCredentialSource,
} from "./client-credential-native-bootstrap.js";
import {
  readClientCredentialReceipt,
  writeClientCredentialReceipt,
} from "./client-credential-readiness.js";
import { CLIENT_CREDENTIAL_SCHEMA_SQL } from "./client-credential-schema.js";
import {
  openClientCredentialCustody,
  runClientCredentialOperation,
} from "./client-credential-store.js";
import { loadDeviceAuthTokenReadOnly } from "./device-auth-store.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { readUpdatePostgresState } from "./update-candidate-state.postgres.js";

const directories = useAutoCleanupTempDirTracker(afterAll);

const identity = CLIENT_CREDENTIAL_SCHEMA_SQL.slice(
  0,
  CLIENT_CREDENTIAL_SCHEMA_SQL.indexOf("CREATE TABLE device_auth_tokens"),
);
const auth = CLIENT_CREDENTIAL_SCHEMA_SQL.slice(
  CLIENT_CREDENTIAL_SCHEMA_SQL.indexOf("CREATE TABLE device_auth_tokens"),
  CLIENT_CREDENTIAL_SCHEMA_SQL.indexOf("CREATE TABLE gateway_origin_device_tokens"),
);

it.each([
  {
    authTablePresent: false,
    sha256: "7d7ade847f734ab42b59b04464a5f1bf5e89e582a7cdd8f2f39b12274e16d038",
  },
  {
    authTablePresent: true,
    sha256: "00823eca1c9659c886cfb6649d1a4ae0ec202a43451409bf755426ae8056c725",
  },
])(
  "hashes native auth-table presence independently of token rows ($authTablePresent)",
  ({ authTablePresent, sha256 }) => {
    const pathname = path.join(directories.make("native-auth-presence-"), "native.sqlite");
    {
      using source = openNodeSqliteDatabase(pathname);
      source.exec(identity + (authTablePresent ? auth : ""));
    }
    expect(readIndependentClientCredentialSource(pathname)).toMatchObject({
      authTablePresent,
      sha256,
    });
  },
);

it.each([identity, auth, identity + auth])(
  "recognizes only canonical native credential table pairs",
  (schema) => {
    using database = openNodeSqliteDatabase(":memory:");
    database.exec(schema);
    expect(isNativeClientCredentialBootstrap(database)).toBe(true);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
  },
);

it.each([
  "",
  `${identity} PRAGMA user_version=1`,
  `${identity} CREATE TABLE exec_approvals_config(raw_json TEXT)`,
  `${identity} CREATE TABLE unrelated(value TEXT)`,
  `${identity} CREATE VIEW exposed AS SELECT private_key_pem FROM device_identities`,
  `${identity} CREATE TRIGGER changed AFTER INSERT ON device_identities BEGIN SELECT 1; END`,
  `${identity} CREATE INDEX extra ON device_identities(created_at_ms)`,
])(
  "does not classify empty, versioned or other application data as native credentials",
  (schema) => {
    using database = openNodeSqliteDatabase(":memory:");
    database.exec(schema);
    expect(isNativeClientCredentialBootstrap(database)).toBe(false);
  },
);

it("refuses names with a different credential schema", () => {
  using database = openNodeSqliteDatabase(":memory:");
  database.exec(identity.replace("private_key_pem TEXT NOT NULL", "private_key_pem BLOB NOT NULL"));
  expect(() => isNativeClientCredentialBootstrap(database)).toThrow();
});

it.each(["", identity + auth])(
  "inspects empty state or refuses native credentials before contacting selected PostgreSQL",
  async (schema) => {
    const root = directories.make("native-bootstrap-capture-");
    const shared = path.join(root, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(shared));
    {
      using source = openNodeSqliteDatabase(shared);
      source.exec(schema || "PRAGMA user_version=0");
    }
    const before = fs.readFileSync(shared);
    const discovery = readUpdatePostgresState(
      {
        stateDir: root,
        env: { ...process.env, OPENCLAW_STATE_DIR: root },
        config: {
          database: {
            engine: "postgres",
            postgres: { connection: "postgresql://synthetic@127.0.0.1:1/unreachable" },
          },
        },
      },
      new Map([[shared, { spellings: [shared] }]]),
    );
    if (schema) {
      await expect(discovery).rejects.toThrow(
        /Start the Gateway once on SQLite and run openclaw doctor --fix, then use openclaw database port/,
      );
    } else {
      expect((await discovery).version).toEqual({ userVersion: 0, contentVersion: 0 });
      expect((await discovery).files).toEqual([[shared, { spellings: [shared] }]]);
    }
    expect(fs.readFileSync(shared)).toEqual(before);
  },
);

it.each([false, true])(
  "opens independent sources without changing bytes, mode or directory (WAL=%s)",
  (wal) => {
    const root = directories.make("independent-readonly-");
    const pathname = path.join(root, "native.sqlite");
    {
      using source = openNodeSqliteDatabase(pathname);
      source.exec(identity + auth);
      if (wal) {
        source.exec("PRAGMA journal_mode=WAL");
      }
    }
    fs.chmodSync(pathname, 0o400);
    const before = fs.readFileSync(pathname);
    const mode = fs.statSync(pathname).mode;
    const entries = fs.readdirSync(root).toSorted();
    if (wal) {
      expect(() => readIndependentClientCredentialSource(pathname)).toThrow(/DELETE journal mode/);
    } else {
      expect(readIndependentClientCredentialSource(pathname).rows.identities).toEqual([]);
    }
    expect(fs.readFileSync(pathname)).toEqual(before);
    expect(fs.statSync(pathname).mode).toBe(mode);
    expect(fs.readdirSync(root).toSorted()).toEqual(entries);
  },
);

it.each([false, true])(
  "keeps refreshed credentials for unchanged native sources and rebuilds changed sources without reviving JSON (initial auth table: %s)",
  async (authTablePresent) => {
    const root = directories.make("independent-admission-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const pathname = path.join(root, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    {
      using source = openNodeSqliteDatabase(pathname);
      source.exec(identity + (authTablePresent ? auth : ""));
      if (authTablePresent) {
        source
          .prepare("INSERT INTO device_auth_tokens VALUES (?,?,?,?,?)")
          .run("device", "operator", "original", "[]", 10);
      }
    }
    const snapshot = readIndependentClientCredentialSource(pathname);
    {
      using local = openClientCredentialCustody(env, { createIfMissing: true, migration: true })!;
      runSqliteImmediateTransactionSync(local.database, () => {
        local.database
          .prepare("INSERT INTO device_auth_tokens VALUES (?,?,?,?,?)")
          .run("device", "operator", "refreshed", "[]", 11);
        writeClientCredentialReceipt(
          local.database,
          {
            format: 1,
            source: {
              kind: "independent",
              engine: "native-v0",
              identity: snapshot.identity,
              generation: "0",
              sha256: snapshot.sha256,
              destinationVersion: 1,
            },
            sharedFile: snapshot.file,
            legacyImports: { "auth:primary": { sha256: "a".repeat(64) } },
          },
          "complete",
        );
      });
    }
    const read = () =>
      runClientCredentialOperation(env, {
        kind: "token.read",
        key: { device_id: "device", role: "operator" },
      });
    expect(read()).toMatchObject({ kind: "token", token: { token: "refreshed" } });
    const beforeInode = fs.statSync(pathname).ino;
    {
      using source = openNodeSqliteDatabase(pathname);
      if (authTablePresent) {
        source.prepare("UPDATE device_auth_tokens SET token='restored',updated_at_ms=12").run();
      } else {
        source.exec(auth);
      }
    }
    expect(fs.statSync(pathname).ino).toBe(beforeInode);
    await expect(
      loadDeviceAuthTokenReadOnly({ env, deviceId: "device", role: "operator" }),
    ).rejects.toThrow(/read-only inspection/);
    expect(() =>
      runClientCredentialOperation(
        env,
        { kind: "token.read", key: { device_id: "device", role: "operator" } },
        { readOnly: true },
      ),
    ).toThrow(/read-only inspection/);
    {
      using local = openClientCredentialCustody(env, { migration: true })!;
      expect(local.database.prepare("SELECT token FROM device_auth_tokens").get()).toEqual({
        token: "refreshed",
      });
      expect(readClientCredentialReceipt(local.database)?.receipt.source?.sha256).toBe(
        snapshot.sha256,
      );
    }
    expect(read()).toMatchObject({
      kind: "token",
      token: authTablePresent ? { token: "restored" } : null,
    });
    using local = openClientCredentialCustody(env, { migration: true })!;
    expect(
      readClientCredentialReceipt(local.database)?.receipt.legacyImports["auth:primary"],
    ).toEqual({ sha256: "a".repeat(64) });
  },
);
