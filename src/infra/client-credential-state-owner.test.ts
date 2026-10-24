import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { recoverClientCredentialStore } from "./client-credential-migration.js";
import type { ClientSocketRecord } from "./client-credential-operations.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import { readClientCredentialReceipt } from "./client-credential-readiness.js";
import { readClientCredentialFileIdentity } from "./client-credential-receipt.js";
import { CLIENT_CREDENTIAL_LEGACY_TABLES_SQL } from "./client-credential-schema.js";
import {
  openClientCredentialCustody,
  runClientCredentialOperation,
} from "./client-credential-store.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});

function fixture(label: string) {
  const root = dirs.make(`client-state-owner-${label}-`);
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  return {
    root,
    env,
    sharedPath: path.join(root, "state", "openclaw.sqlite"),
    localPath: resolveClientCredentialStorePath(env),
  };
}

const digest = (pathname: string) =>
  createHash("sha256").update(fs.readFileSync(pathname)).digest("hex");

function receipt(env: NodeJS.ProcessEnv) {
  using owner = openClientCredentialCustody(env, { migration: true })!;
  return readClientCredentialReceipt(owner.database);
}

it.each([false, true])(
  "keeps explicit canonical root credentials independent of ambient state (material=%s)",
  (material) => {
    const ambient = fixture("ambient");
    const selected = fixture("selected");
    openOpenClawStateDatabase({ env: ambient.env });
    const socket: ClientSocketRecord = {
      socket_key: "current",
      socket_path: path.join(ambient.root, "exec.sock"),
      socket_token: "synthetic-retained-socket",
      updated_at_ms: 7,
    };
    if (material) {
      runClientCredentialOperation(ambient.env, { kind: "socket.ensure", fallback: socket });
    }
    const previous = receipt(ambient.env);
    const before = digest(ambient.localPath);
    const shared = openOpenClawStateDatabase({
      path: selected.sharedPath,
      env: ambient.env,
    });
    expect(receipt(selected.env)?.receipt.sharedFile).toEqual(
      readClientCredentialFileIdentity(selected.sharedPath),
    );
    // Doctor recovery uses the same selected shared source, even with ambient caller env.
    recoverClientCredentialStore(shared.db, { path: shared.path, env: ambient.env });
    expect(
      runClientCredentialOperation(selected.env, { kind: "socket.read" }, { readOnly: true }),
    ).toEqual({ kind: "socket", socket: null });
    expect(
      runClientCredentialOperation(ambient.env, { kind: "socket.read" }, { readOnly: true }),
    ).toEqual({ kind: "socket", socket: material ? socket : null });
    expect(receipt(ambient.env)).toEqual(previous);
    expect(digest(ambient.localPath)).toBe(before);
  },
);

it.each([false, true])(
  "opens standalone shared data without claiming local credentials (ambient exists=%s)",
  (existing) => {
    const ambient = fixture("aux-ambient");
    const auxiliary = fixture("auxiliary");
    if (existing) {
      openOpenClawStateDatabase({ env: ambient.env });
    }
    const before = existing ? digest(ambient.localPath) : null;
    const pathname = path.join(auxiliary.root, "openclaw.sqlite");
    const database = openOpenClawStateDatabase({ path: pathname, env: ambient.env });
    database.db.exec("CREATE TABLE auxiliary_sentinel(value TEXT)");
    database.db.prepare("INSERT INTO auxiliary_sentinel VALUES (?)").run("retained");
    recoverClientCredentialStore(database.db, { path: pathname, env: ambient.env });
    expect(database.db.prepare("SELECT value FROM auxiliary_sentinel").get()).toEqual({
      value: "retained",
    });
    expect(fs.existsSync(auxiliary.localPath)).toBe(false);
    expect(fs.existsSync(ambient.localPath)).toBe(existing);
    if (existing) {
      expect(digest(ambient.localPath)).toBe(before);
      expect(
        runClientCredentialOperation(ambient.env, { kind: "socket.read" }, { readOnly: true }),
      ).toEqual({ kind: "socket", socket: null });
    }
  },
);

it("preserves a credential-bearing standalone source without backed-up migration custody", async () => {
  const ambient = fixture("legacy-ambient");
  const auxiliary = fixture("legacy-auxiliary");
  const pathname = path.join(auxiliary.root, "openclaw.sqlite");
  {
    using source = openNodeSqliteDatabase(pathname);
    source.exec(CLIENT_CREDENTIAL_LEGACY_TABLES_SQL);
    // Native Swift bootstrap owns only identity and auth-token tables.
    source.exec("DROP TABLE gateway_origin_device_tokens");
    source
      .prepare("INSERT INTO device_identities VALUES (?,?,?,?,?,?)")
      .run("primary", "synthetic-id", "synthetic-public", "synthetic-private", 1, 1);
    source
      .prepare("INSERT INTO device_auth_tokens VALUES (?,?,?,?,?)")
      .run("synthetic-id", "operator", "synthetic-retained-token", "[]", 1);
  }
  const snapshot = () => {
    using source = openNodeSqliteDatabase(pathname, { readOnly: true });
    return {
      version: source.prepare("PRAGMA user_version").get(),
      schema: source
        .prepare(
          "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all(),
      identities: source.prepare("SELECT * FROM device_identities ORDER BY identity_key").all(),
      tokens: source.prepare("SELECT * FROM device_auth_tokens ORDER BY device_id,role").all(),
    };
  };
  const before = snapshot();
  expect(() => openOpenClawStateDatabase({ path: pathname, env: ambient.env })).toThrow(
    "backed-up migration custody",
  );
  await closeOpenClawStateDatabaseAsync();
  expect(snapshot()).toEqual(before);
  expect(fs.existsSync(ambient.localPath)).toBe(false);
  expect(fs.existsSync(auxiliary.localPath)).toBe(false);
});

it("still refuses an actual shared generation replacement without changing retained material", async () => {
  const selected = fixture("generation");
  const donor = fixture("donor");
  openOpenClawStateDatabase({ env: selected.env });
  openOpenClawStateDatabase({ env: donor.env });
  runClientCredentialOperation(selected.env, {
    kind: "socket.ensure",
    fallback: {
      socket_key: "current",
      socket_path: path.join(selected.root, "exec.sock"),
      socket_token: "synthetic-retained-token",
      updated_at_ms: 7,
    },
  });
  const before = digest(selected.localPath);
  const original = readClientCredentialFileIdentity(selected.sharedPath)!;
  await closeOpenClawStateDatabaseAsync();
  const replacement = path.join(selected.root, "replacement.sqlite");
  fs.copyFileSync(donor.sharedPath, replacement);
  fs.renameSync(replacement, selected.sharedPath);
  expect(readClientCredentialFileIdentity(selected.sharedPath)?.ino).not.toBe(original.ino);
  expect(() =>
    runClientCredentialOperation(selected.env, { kind: "socket.read" }, { readOnly: true }),
  ).toThrow("migration is incomplete or stale");
  expect(digest(selected.localPath)).toBe(before);
});
