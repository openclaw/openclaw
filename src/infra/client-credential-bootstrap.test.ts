import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { bindFreshClientCredentialStore } from "./client-credential-migration.js";
import {
  readClientCredentialReceipt,
  writeClientCredentialReceipt,
} from "./client-credential-readiness.js";
import {
  readClientCredentialFileIdentity,
  type ClientCredentialReceipt,
} from "./client-credential-receipt.js";
import {
  openClientCredentialCustody,
  runClientCredentialOperation,
} from "./client-credential-store.js";
import { generateStoredDeviceIdentity } from "./device-identity-material.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const storeId = "00000000-0000-4000-8000-000000000001";
const namespace = "synthetic_state_0000000000004000";

function fixture(credentials = true) {
  const root = dirs.make("client-credential-bootstrap-");
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  const material = generateStoredDeviceIdentity(17);
  const identity = {
    identity_key: "primary",
    device_id: material.deviceId,
    public_key_pem: material.publicKeyPem,
    private_key_pem: material.privateKeyPem,
    created_at_ms: 17,
    updated_at_ms: 19,
  };
  const token = {
    device_id: material.deviceId,
    role: "operator",
    token: "synthetic-existing-operator-token",
    scopes_json: '["operator.read"]',
    updated_at_ms: 23,
  };
  if (credentials) {
    runClientCredentialOperation(env, { kind: "identity.create", identity });
    runClientCredentialOperation(env, { kind: "token.replace", key: token, token });
  }
  const sourcePath = path.join(root, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  return { env, identity, token, sourcePath };
}

function createAnchor(source: DatabaseSync) {
  source.exec(
    "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine = 'postgres'), schema TEXT NOT NULL)",
  );
  source
    .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
    .run(storeId, namespace);
}

type Fixture = ReturnType<typeof fixture>;

function bindNow(source: DatabaseSync, f: Fixture) {
  bindFreshClientCredentialStore(source, { path: f.sourcePath, env: f.env });
}

function bind(source: DatabaseSync, f: Fixture) {
  runSqliteImmediateTransactionSync(source, () => bindNow(source, f));
}

function postgresFixture() {
  const f = fixture();
  using source = openNodeSqliteDatabase(f.sourcePath);
  createAnchor(source);
  bind(source, f);
  return f;
}

function editReceipt(
  f: Fixture,
  edit: (receipt: NonNullable<ReturnType<typeof readClientCredentialReceipt>>["receipt"]) => void,
  phase: "copied" | "complete" = "complete",
) {
  using owner = openClientCredentialCustody(f.env, { migration: true })!;
  const stored = readClientCredentialReceipt(owner.database)!;
  edit(stored.receipt);
  owner.transaction(() => writeClientCredentialReceipt(owner.database, stored.receipt, phase));
}

function failAfterCommit(f: Fixture, prepare: (source: DatabaseSync) => void) {
  const source = openNodeSqliteDatabase(f.sourcePath);
  try {
    expect(() =>
      runSqliteImmediateTransactionSync(source, () => prepare(source), {
        withCommit(commit) {
          commit();
          throw new Error("fixture owner failed after native commit");
        },
      }),
    ).toThrow("fixture owner failed after native commit");
    expect(source.isOpen).toBe(false);
  } finally {
    if (source.isOpen) {
      source.close();
    }
  }
}

function readIdentity(f: Fixture) {
  return runClientCredentialOperation(
    f.env,
    { kind: "identity.read", identity_key: "primary" },
    { readOnly: true },
  );
}

function expectSentinel(source: DatabaseSync, value: number) {
  expect(source.prepare("SELECT value FROM bootstrap_sentinel").get()).toEqual({ value });
}

function expectNoTable(source: DatabaseSync, name: string) {
  expect(source.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(name)).toBeUndefined();
}

function localSnapshot(env: NodeJS.ProcessEnv) {
  using owner = openClientCredentialCustody(env, { migration: true })!;
  return {
    receipt: readClientCredentialReceipt(owner.database),
    rawReceipt: owner.database.prepare("SELECT * FROM client_credential_migration").all(),
    identities: owner.database
      .prepare("SELECT * FROM device_identities ORDER BY identity_key")
      .all(),
    tokens: owner.database
      .prepare("SELECT * FROM device_auth_tokens ORDER BY device_id, role")
      .all(),
    origins: owner.database
      .prepare("SELECT * FROM gateway_origin_device_tokens ORDER BY gateway_scope, device_id, role")
      .all(),
    sockets: owner.database.prepare("SELECT * FROM native_exec_socket_credentials").all(),
  };
}

const emptyMaterial = { identities: [], tokens: [], origins: [], sockets: [] };

function expectBinding(
  f: Fixture,
  source: Partial<NonNullable<ClientCredentialReceipt["source"]>>,
  previous?: ReturnType<typeof localSnapshot>,
  sharedFile = readClientCredentialFileIdentity(f.sourcePath),
) {
  expect(localSnapshot(f.env)).toMatchObject({
    ...(previous && {
      identities: previous.identities,
      tokens: previous.tokens,
      origins: previous.origins,
      sockets: previous.sockets,
    }),
    receipt: {
      phase: "complete",
      receipt: {
        source,
        sharedFile,
        ...(previous && { legacyImports: previous.receipt!.receipt.legacyImports }),
      },
    },
  });
}

function createSqliteSource(source: DatabaseSync, createdAt: number) {
  source.exec("CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, created_at INTEGER)");
  source.prepare("INSERT INTO schema_meta VALUES ('primary', ?)").run(createdAt);
  source.exec("CREATE TABLE bootstrap_sentinel (value INTEGER)");
  source.prepare("INSERT INTO bootstrap_sentinel VALUES (?)").run(createdAt);
}

function sqliteFixture() {
  const f = fixture(false);
  using source = openNodeSqliteDatabase(f.sourcePath);
  createSqliteSource(source, 17);
  bind(source, f);
  return f;
}

function expectSqliteRebindRefused(f: Fixture) {
  const previous = localSnapshot(f.env);
  fs.renameSync(f.sourcePath, `${f.sourcePath}.previous`);
  using source = openNodeSqliteDatabase(f.sourcePath);
  createSqliteSource(source, 23);
  expect(() => bind(source, f)).toThrow(/previous shared database/);
  expect(localSnapshot(f.env)).toEqual(previous);
  expectSentinel(source, 23);
}

function expectCredentialsReadable(f: Fixture) {
  expect(readIdentity(f)).toEqual({ kind: "identity", identity: f.identity });
  expect(
    runClientCredentialOperation(f.env, { kind: "token.read", key: f.token }, { readOnly: true }),
  ).toEqual({ kind: "token", token: f.token });
}

describe("fresh PostgreSQL client credential binding", () => {
  it("publishes the durable anchor identity before any remote schema exists", () => {
    const f = fixture();
    using source = openNodeSqliteDatabase(f.sourcePath);
    runSqliteImmediateTransactionSync(source, () => {
      createAnchor(source);
      bindNow(source, f);
    });
    expectNoTable(source, "schema_meta");
    expectBinding(f, {
      kind: "canonical",
      engine: "postgres",
      identity: storeId,
      generation: `bootstrap:${storeId}`,
    });
    expectCredentialsReadable(f);
  });

  it("resumes a copied receipt on the same committed anchor without replacing local credentials", () => {
    const f = fixture();
    const previous = localSnapshot(f.env);
    failAfterCommit(f, (source) => {
      createAnchor(source);
      bindNow(source, f);
    });
    const pending = localSnapshot(f.env);
    expect(pending.receipt).toEqual({
      phase: "copied",
      receipt: {
        ...previous.receipt!.receipt,
        source: null,
        sharedFile: readClientCredentialFileIdentity(f.sourcePath),
      },
    });
    using resumed = openNodeSqliteDatabase(f.sourcePath);
    const anchor = resumed.prepare("SELECT * FROM openclaw_engine_anchor").all();
    expect(anchor).toEqual([{ store_id: storeId, engine: "postgres", schema: namespace }]);
    bind(resumed, f);
    expect(resumed.prepare("SELECT * FROM openclaw_engine_anchor").all()).toEqual(anchor);
    expectBinding(
      f,
      { engine: "postgres", identity: storeId, generation: `bootstrap:${storeId}` },
      previous,
      pending.receipt!.receipt.sharedFile,
    );
    expectCredentialsReadable(f);
  });

  it.each([false, true])(
    "restores claims after rollback and retry (existing binding=%s)",
    (bound) => {
      const f = bound ? postgresFixture() : fixture();
      using source = openNodeSqliteDatabase(f.sourcePath);
      const previous = localSnapshot(f.env);
      expect(() =>
        runSqliteImmediateTransactionSync(source, () => {
          if (!bound) {
            createAnchor(source);
          }
          bindNow(source, f);
          source.exec("CREATE TABLE rolled_back_binding (value TEXT)");
          throw new Error("fixture binding rollback");
        }),
      ).toThrow("fixture binding rollback");
      expect(source.isTransaction).toBe(false);
      expectNoTable(source, "rolled_back_binding");
      if (!bound) {
        expectNoTable(source, "openclaw_engine_anchor");
      }
      expect(localSnapshot(f.env)).toEqual(previous);
      expectCredentialsReadable(f);
      runSqliteImmediateTransactionSync(source, () => {
        if (!bound) {
          createAnchor(source);
        }
        bindNow(source, f);
      });
      if (bound) {
        expect(localSnapshot(f.env)).toMatchObject({
          receipt: previous.receipt,
          identities: previous.identities,
          tokens: previous.tokens,
          origins: previous.origins,
          sockets: previous.sockets,
        });
      }
      expect(localSnapshot(f.env).receipt?.receipt.legacyImports).toEqual(
        previous.receipt!.receipt.legacyImports,
      );
      expectCredentialsReadable(f);
    },
  );

  it("refuses a different durable store identity without changing local credentials or receipts", () => {
    const f = postgresFixture();
    using source = openNodeSqliteDatabase(f.sourcePath);
    const previous = localSnapshot(f.env);
    source.prepare("UPDATE openclaw_engine_anchor SET store_id = ?").run("another-store");
    expect(() => bind(source, f)).toThrow(/previous shared database/);
    expect(localSnapshot(f.env)).toEqual(previous);
  });

  it("refuses a replaced anchor file even when its durable store identity matches", () => {
    const f = postgresFixture();
    const previous = localSnapshot(f.env);
    fs.renameSync(f.sourcePath, `${f.sourcePath}.previous`);
    using replacement = openNodeSqliteDatabase(f.sourcePath);
    createAnchor(replacement);
    expect(readClientCredentialFileIdentity(f.sourcePath)).not.toEqual(
      previous.receipt?.receipt.sharedFile,
    );
    expect(() => bind(replacement, f)).toThrow(/previous shared database/);
    expect(localSnapshot(f.env)).toEqual(previous);
  });

  it("refuses historical canonical migration provenance when the remote store looks fresh", () => {
    const f = postgresFixture();
    using source = openNodeSqliteDatabase(f.sourcePath);
    editReceipt(f, (receipt) => {
      receipt.source!.generation = "7".repeat(64);
      receipt.source!.sha256 = "8".repeat(64);
    });
    const previous = localSnapshot(f.env);
    expect(() => bind(source, f)).toThrow(/previous shared database/);
    expect(localSnapshot(f.env)).toEqual(previous);
    expectCredentialsReadable(f);
  });

  it.each([
    { label: "an empty anchor", rows: [] },
    {
      label: "multiple anchor identities",
      rows: [
        [storeId, "postgres", namespace],
        ["another-store", "postgres", "another_schema"],
      ],
    },
    { label: "the wrong engine", rows: [[storeId, "sqlite", namespace]] },
    { label: "an empty store identity", rows: [["", "postgres", namespace]] },
    { label: "a non-string store identity", rows: [[42, "postgres", namespace]] },
    { label: "a blank schema", rows: [[storeId, "postgres", "  "]] },
    { label: "a non-string schema", rows: [[storeId, "postgres", 42]] },
  ])("rejects $label before changing the local receipt", ({ rows }) => {
    const f = fixture();
    using source = openNodeSqliteDatabase(f.sourcePath);
    source.exec("CREATE TABLE openclaw_engine_anchor (store_id, engine, schema)");
    for (const row of rows) {
      source.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, ?, ?)").run(...row);
    }
    const previous = localSnapshot(f.env);
    expect(() => bind(source, f)).toThrow(/Invalid PostgreSQL anchor identity/);
    expect(localSnapshot(f.env)).toEqual(previous);
  });

  it("rejects missing anchor identity columns before changing the local receipt", () => {
    const f = fixture();
    using source = openNodeSqliteDatabase(f.sourcePath);
    source.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT)");
    const previous = localSnapshot(f.env);
    expect(() => bind(source, f)).toThrow(/no such column/);
    expect(localSnapshot(f.env)).toEqual(previous);
  });
});

describe("fresh SQLite client credential binding", () => {
  it("restores the old readable binding after rollback and admits the same fresh source on retry", () => {
    const f = sqliteFixture();
    const previous = localSnapshot(f.env);
    const previousPath = `${f.sourcePath}.previous`;
    const replacementPath = `${f.sourcePath}.replacement`;
    fs.renameSync(f.sourcePath, previousPath);
    {
      using source = openNodeSqliteDatabase(f.sourcePath);
      expect(() =>
        runSqliteImmediateTransactionSync(source, () => {
          bindNow(source, f);
          createSqliteSource(source, 23);
          throw new Error("fixture rebind rollback");
        }),
      ).toThrow("fixture rebind rollback");
      expect(source.isTransaction).toBe(false);
      expectNoTable(source, "bootstrap_sentinel");
      expect(localSnapshot(f.env)).toEqual(previous);
    }
    fs.renameSync(f.sourcePath, replacementPath);
    fs.renameSync(previousPath, f.sourcePath);
    expect(readIdentity(f)).toEqual({ kind: "identity", identity: null });
    // Restore the same replacement generation for retry after proving rollback readability.
    expect(localSnapshot(f.env)).toEqual(previous);
    fs.renameSync(f.sourcePath, previousPath);
    fs.renameSync(replacementPath, f.sourcePath);
    using retried = openNodeSqliteDatabase(f.sourcePath);
    runSqliteImmediateTransactionSync(retried, () => {
      createSqliteSource(retried, 23);
      bindNow(retried, f);
    });
    expectBinding(f, { identity: `${fs.realpathSync(f.sourcePath)}:23` });
    expectSentinel(retried, 23);
    expect(
      runClientCredentialOperation(f.env, { kind: "socket.read" }, { readOnly: true }),
    ).toEqual({ kind: "socket", socket: null });
    using first = openNodeSqliteDatabase(previousPath);
    expectSentinel(first, 17);
  });

  it("restores receipt absence after first-use rollback and permits a fresh retry", () => {
    const f = fixture(false);
    using source = openNodeSqliteDatabase(f.sourcePath);
    expect(() =>
      runSqliteImmediateTransactionSync(source, () => {
        bindNow(source, f);
        createSqliteSource(source, 17);
        throw new Error("fixture first-use rollback");
      }),
    ).toThrow("fixture first-use rollback");
    expect(localSnapshot(f.env)).toEqual({
      receipt: null,
      rawReceipt: [],
      ...emptyMaterial,
    });
    expectNoTable(source, "bootstrap_sentinel");
    runSqliteImmediateTransactionSync(source, () => {
      createSqliteSource(source, 17);
      bindNow(source, f);
    });
    expect(localSnapshot(f.env).receipt?.phase).toBe("complete");
    expect(readIdentity(f)).toEqual({ kind: "identity", identity: null });
  });

  it.each([false, true])(
    "refuses missing managed custody before changing a receipt (native transaction=%s)",
    (native) => {
      const f = sqliteFixture();
      const previous = localSnapshot(f.env);
      fs.renameSync(f.sourcePath, `${f.sourcePath}.previous`);
      using source = openNodeSqliteDatabase(f.sourcePath);
      if (native) {
        source.exec("BEGIN IMMEDIATE");
      }
      try {
        expect(() => bindNow(source, f)).toThrow(
          "Client credential bootstrap has no source commit lifecycle",
        );
      } finally {
        if (source.isTransaction) {
          source.exec("ROLLBACK");
        }
      }
      expect(localSnapshot(f.env)).toEqual(previous);
    },
  );

  it("retains a parseable copied fence when the source committed before its owner failed", () => {
    const f = sqliteFixture();
    const previous = localSnapshot(f.env);
    fs.renameSync(f.sourcePath, `${f.sourcePath}.previous`);
    failAfterCommit(f, (source) => {
      bindNow(source, f);
      createSqliteSource(source, 23);
    });
    const pending = localSnapshot(f.env);
    expect(pending.rawReceipt).not.toEqual(previous.rawReceipt);
    expect(pending.receipt).toEqual({
      phase: "copied",
      receipt: {
        format: 1,
        source: null,
        sharedFile: readClientCredentialFileIdentity(f.sourcePath),
        legacyImports: {},
      },
    });
    expect(() => readIdentity(f)).toThrow("migration is incomplete or stale");
    const committedPath = `${f.sourcePath}.committed`;
    fs.renameSync(f.sourcePath, committedPath);
    using committed = openNodeSqliteDatabase(committedPath);
    expectSentinel(committed, 23);
    using replacement = openNodeSqliteDatabase(f.sourcePath);
    createSqliteSource(replacement, 31);
    expect(() => bind(replacement, f)).toThrow(/previous shared database/);
    expect(localSnapshot(f.env)).toEqual(pending);
    expectSentinel(committed, 23);
    expectSentinel(replacement, 31);
  });

  it.each(["sqlite", "postgres"] as const)(
    "preserves material-bearing legacy null-source binding against a different fresh %s source",
    (engine) => {
      const f = fixture();
      runClientCredentialOperation(f.env, {
        kind: "token.replace",
        key: { ...f.token, gateway_scope: "fixture" },
        token: f.token,
      });
      runClientCredentialOperation(f.env, {
        kind: "socket.ensure",
        fallback: {
          socket_key: "current",
          socket_path: path.join(f.env.OPENCLAW_STATE_DIR, "exec.sock"),
          socket_token: "synthetic-socket-token",
          updated_at_ms: 29,
        },
      });
      {
        using first = openNodeSqliteDatabase(f.sourcePath);
        createSqliteSource(first, 17);
        bind(first, f);
      }
      editReceipt(f, (receipt) => {
        receipt.source = null;
      });
      const previous = localSnapshot(f.env);
      expect(previous.receipt?.receipt.source).toBeNull();
      expect(previous.receipt?.receipt.legacyImports).toHaveProperty("identity:primary", {
        sha256: null,
      });
      for (const material of ["identities", "tokens", "origins", "sockets"] as const) {
        expect(previous[material]).toHaveLength(1);
      }
      expectCredentialsReadable(f);
      const previousPath = `${f.sourcePath}.previous`;
      fs.renameSync(f.sourcePath, previousPath);
      {
        using replacement = openNodeSqliteDatabase(f.sourcePath);
        if (engine === "postgres") {
          createAnchor(replacement);
        } else {
          createSqliteSource(replacement, 23);
        }
        expect(() => bind(replacement, f)).toThrow(/previous shared database/);
        expect(localSnapshot(f.env)).toEqual(previous);
      }
      fs.renameSync(f.sourcePath, `${f.sourcePath}.refused`);
      fs.renameSync(previousPath, f.sourcePath);
      using first = openNodeSqliteDatabase(f.sourcePath);
      expectSentinel(first, 17);
      expectCredentialsReadable(f);

      // The historical same-file bootstrap remains eligible for provenance enrichment.
      bind(first, f);
      expectBinding(
        f,
        { engine: "sqlite", identity: `${fs.realpathSync(f.sourcePath)}:17` },
        previous,
        previous.receipt!.receipt.sharedFile,
      );
      expectCredentialsReadable(f);
    },
  );

  it("binds a replacement canonical generation when the previous bootstrap has no material or claims", () => {
    const f = sqliteFixture();
    const previous = localSnapshot(f.env);
    expect(previous.receipt?.receipt.legacyImports).toEqual({});
    expect(previous).toMatchObject({
      receipt: { phase: "complete" },
      ...emptyMaterial,
    });
    const previousPath = `${f.sourcePath}.previous`;
    fs.renameSync(f.sourcePath, previousPath);
    using source = openNodeSqliteDatabase(f.sourcePath);
    createSqliteSource(source, 23);
    bind(source, f);
    const nextSnapshot = localSnapshot(f.env);
    expect(nextSnapshot.receipt?.receipt.legacyImports).toEqual({});
    expectBinding(
      f,
      {
        kind: "canonical",
        engine: "sqlite",
        identity: `${fs.realpathSync(f.sourcePath)}:23`,
        generation: "bootstrap:23",
      },
      previous,
    );
    expect(
      runClientCredentialOperation(f.env, { kind: "socket.read" }, { readOnly: true }),
    ).toEqual({ kind: "socket", socket: null });
    using first = openNodeSqliteDatabase(previousPath);
    expectSentinel(first, 17);
    expectSentinel(source, 23);
  });

  it.each(["identities", "tokens", "origins", "sockets"] as const)(
    "preserves a bootstrap with local %s",
    (material) => {
      const f = sqliteFixture();
      {
        using owner = openClientCredentialCustody(f.env, { migration: true })!;
        if (material === "identities") {
          owner.run({ kind: "identity.create", identity: f.identity });
        } else if (material === "sockets") {
          owner.run({
            kind: "socket.ensure",
            fallback: {
              socket_key: "current",
              socket_path: path.join(f.env.OPENCLAW_STATE_DIR, "exec.sock"),
              socket_token: "synthetic-socket-token",
              updated_at_ms: 23,
            },
          });
        } else {
          owner.run({
            kind: "token.replace",
            key: { ...f.token, ...(material === "origins" ? { gateway_scope: "fixture" } : {}) },
            token: f.token,
          });
        }
      }
      const before = localSnapshot(f.env);
      expect(before[material]).toHaveLength(1);
      expect(before.receipt?.receipt.legacyImports).toEqual({});
      expectSqliteRebindRefused(f);
    },
  );

  it.each([
    { key: "identity:primary", sha256: null },
    { key: "auth:node", sha256: "7".repeat(64) },
  ] as const)("preserves consumed $key with digest $sha256", ({ key, sha256 }) => {
    const f = sqliteFixture();
    editReceipt(f, (receipt) => {
      receipt.legacyImports[key] = { sha256 };
    });
    expectSqliteRebindRefused(f);
  });

  it.each([
    "copied",
    "migrated",
    "independent",
    "native",
    "inconsistent identity",
    "missing shared binding",
    "empty bootstrap generation",
    "nonempty digest",
  ] as const)("preserves %s provenance even without local material", (provenance) => {
    const f = sqliteFixture();
    editReceipt(
      f,
      (receipt) => {
        const source = receipt.source!;
        if (provenance === "migrated") {
          source.generation = "7".repeat(64);
        } else if (provenance === "independent" || provenance === "native") {
          source.engine = "native-v0";
          if (provenance === "independent") {
            source.kind = "independent";
          }
        } else if (provenance === "inconsistent identity") {
          source.identity = `${receipt.sharedFile!.path}:another-generation`;
        } else if (provenance === "missing shared binding") {
          receipt.sharedFile = null;
        } else if (provenance === "empty bootstrap generation") {
          source.generation = "bootstrap:";
          source.identity = `${receipt.sharedFile!.path}:`;
        } else if (provenance === "nonempty digest") {
          source.sha256 = "8".repeat(64);
        }
      },
      provenance === "copied" ? "copied" : "complete",
    );
    expectSqliteRebindRefused(f);
  });

  it.each(["sqlite", "postgres"] as const)(
    "does not reassign empty %s bootstrap provenance across engines",
    (firstEngine) => {
      const f = fixture(false);
      {
        using first = openNodeSqliteDatabase(f.sourcePath);
        if (firstEngine === "sqlite") {
          createSqliteSource(first, 17);
        } else {
          createAnchor(first);
        }
        bind(first, f);
      }
      if (firstEngine === "postgres") {
        expectSqliteRebindRefused(f);
        return;
      }
      const previous = localSnapshot(f.env);
      fs.renameSync(f.sourcePath, `${f.sourcePath}.previous`);
      using target = openNodeSqliteDatabase(f.sourcePath);
      createAnchor(target);
      expect(() => bind(target, f)).toThrow(/previous shared database/);
      expect(localSnapshot(f.env)).toEqual(previous);
    },
  );
});
