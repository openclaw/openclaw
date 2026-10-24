import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { cliRecoveryEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import {
  readClientCredentialReceipt,
  writeClientCredentialReceipt,
} from "../infra/client-credential-readiness.js";
import {
  CLIENT_CREDENTIAL_LEGACY_KEYS,
  readClientCredentialFileIdentity,
} from "../infra/client-credential-receipt.js";
import { openClientCredentialCustody } from "../infra/client-credential-store.js";
import {
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "../infra/database-engine/admission-scope.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { openEngineStore } from "../infra/database-engine/open.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import {
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
} from "../infra/device-identity.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { stateEngineSchema } from "../state/openclaw-state-db-engine.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import {
  createBuiltRuntime,
  runBuiltRuntime,
} from "./doctor-config-preflight.process.test-support.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const namespaces = new Set<string>();
const runtimes = useAutoCleanupTempDirTracker(afterAll);
const missingMessage =
  "Local credentials are missing; restore the matching client credential backup.";
let runtimeRoot: string;

beforeAll(() => {
  if (!connection) {
    return;
  }
  installDatabaseProcessRole("cli-oneshot");
  const entry = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli);
  runtimeRoot = createBuiltRuntime(
    runtimes.make("credential-cli-runtime-"),
    path.dirname(fileURLToPath(entry)),
  );
});
afterAll(async () => {
  if (!connection || !namespaces.size) {
    return;
  }
  const client = new Client({ connectionString: connection });
  await client.connect();
  try {
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
    }
  } finally {
    await client.end();
  }
});

describe.skipIf(!connection)("PostgreSQL missing credential Doctor CLI recovery", () => {
  const dirs = useStateDatabaseTempDirs();
  async function bootstrap(engine: "postgres" | "sqlite" = "postgres", preCutover = false) {
    const root = fs.realpathSync(dirs.make("credential-rebind-"));
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_PROFILE: "default",
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_HIDE_BANNER: "1",
      VITEST: undefined,
      VITEST_POOL_ID: undefined,
      VITEST_WORKER_ID: undefined,
    };
    const config = {
      database: {
        families: { state: { engine } },
        ...(engine === "postgres"
          ? { postgres: { connection: connection!, schemaPrefix: "credential_rebind" } }
          : {}),
      },
    };
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
    const identity = loadOrCreateDeviceIdentity({ env });
    let namespace: string | undefined;
    withDatabaseEngineSelection(
      {
        effectiveEngines: resolveDatabaseFamilyEngines(config),
        postgres: config.database.postgres,
      },
      () =>
        withEngineStoreAdmission(() => {
          if (preCutover) {
            const anchorPath = path.join(root, "state", "openclaw.sqlite");
            fs.mkdirSync(path.dirname(anchorPath), { recursive: true });
            using anchor = openNodeSqliteDatabase(anchorPath);
            const version = CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION - 1;
            const migration = stateEngineSchema.postgresMigrations!.find(
              (step) => step.version === CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION,
            )!;
            const source = openEngineStore({
              anchor,
              schema: { id: "state", version, sqlite: "", ...migration.fromSchema },
              input: config.database.postgres!,
              inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: false }),
              prepareAnchor() {},
              openSqlite() {
                throw new Error("Expected PostgreSQL");
              },
            });
            try {
              if (!isPostgresSqlConnection(source)) {
                throw new Error("Expected PostgreSQL credential fixture");
              }
              namespace = getPostgresPhysicalFacts(source)?.namespace;
              if (namespace) {
                namespaces.add(namespace);
              }
              source.runTransaction(() => {
                source
                  .prepare(
                    "INSERT INTO schema_meta VALUES ('primary','global',?,NULL,'fixture',123,123)",
                  )
                  .run(version);
                source
                  .prepare(
                    "INSERT INTO config_machine_state VALUES ('state.schema.contentVersion',?,1)",
                  )
                  .run(String(version));
                source
                  .prepare("INSERT INTO device_identities VALUES (?,?,?,?,?,?)")
                  .run(
                    "primary",
                    identity.deviceId,
                    identity.publicKeyPem,
                    identity.privateKeyPem,
                    12,
                    99,
                  );
                source
                  .prepare("INSERT INTO device_auth_tokens VALUES (?,?,?,?,?)")
                  .run(identity.deviceId, "operator", "synthetic-before-cutover-token", "[]", 101);
              });
            } finally {
              source.close();
            }
            return;
          }
          const state = openOpenClawStateDatabase({ env });
          namespace = getPostgresPhysicalFacts(state.db)?.namespace;
          if (namespace) {
            namespaces.add(namespace);
          }
          runSqliteImmediateTransactionSync(state.db, () => {
            state.db
              .prepare(
                "INSERT INTO device_pairing_paired (device_id, public_key, tokens_json, created_at_ms, approved_at_ms) VALUES (?, ?, ?, ?, ?)",
              )
              .run(
                "retained-remote",
                "synthetic-public-key",
                '{"operator":{"token":"synthetic-remote-token"}}',
                1,
                1,
              );
          });
        }),
    );
    await closeOpenClawStateDatabaseAsync();
    const local = path.join(root, "client", "credentials.sqlite");
    const anchor = path.join(root, "state", "openclaw.sqlite");
    return { root, env, local, anchor, namespace, identity, source: receipt(env)!.receipt.source };
  }
  function receipt(env: NodeJS.ProcessEnv) {
    using owner = openClientCredentialCustody(env, { readOnly: true, migration: true });
    return owner && readClientCredentialReceipt(owner.database);
  }
  function doctor(f: Awaited<ReturnType<typeof bootstrap>>, args: string[] = ["--fix", "--yes"]) {
    return runBuiltRuntime(runtimeRoot, f.env, ["doctor", ...args], 120_000);
  }
  function replaceAnchor(anchor: string) {
    fs.copyFileSync(anchor, `${anchor}.replacement`);
    fs.renameSync(`${anchor}.replacement`, anchor);
  }

  it("repairs with --fix --yes, seals legacy imports, and survives a later anchor replacement", async () => {
    const f = await bootstrap();
    const legacy = path.join(f.root, "identity");
    fs.mkdirSync(legacy, { recursive: true });
    const retained = {
      "device.json": JSON.stringify({ version: 1, ...f.identity, createdAtMs: 1 }),
      "device-auth.json": JSON.stringify({
        version: 1,
        deviceId: f.identity.deviceId,
        tokens: {
          operator: {
            token: "synthetic-retired-token",
            role: "operator",
            scopes: [],
            updatedAtMs: 1,
          },
        },
      }),
    };
    for (const [name, bytes] of Object.entries(retained)) {
      fs.writeFileSync(path.join(legacy, name), bytes);
    }
    fs.rmSync(path.dirname(f.local), { recursive: true });
    const recovered = await doctor(f);
    expect(recovered.code, recovered.stderr || recovered.stdout).toBe(0);
    expect(recovered.stdout + recovered.stderr).toContain("Clients on this host");
    expect(receipt(f.env)).toEqual({
      phase: "complete",
      receipt: {
        format: 1,
        source: f.source,
        sharedFile: readClientCredentialFileIdentity(f.anchor),
        legacyImports: Object.fromEntries(
          CLIENT_CREDENTIAL_LEGACY_KEYS.map((key) => [key, { sha256: null }]),
        ),
      },
    });
    expect(loadDeviceIdentityIfPresent({ env: f.env })).toBeNull();
    {
      using owner = openClientCredentialCustody(f.env, { readOnly: true })!;
      expect(
        owner.database.prepare("SELECT COUNT(*) AS count FROM device_auth_tokens").get()?.count,
      ).toBe(0);
    }
    const replacementIdentity = loadOrCreateDeviceIdentity({ env: f.env });
    expect(replacementIdentity.deviceId).not.toBe(f.identity.deviceId);
    replaceAnchor(f.anchor);
    const later = await doctor(f, ["--repair", "--yes"]);
    expect(later.code, later.stderr).toBe(0);
    expect(loadDeviceIdentityIfPresent({ env: f.env })).toEqual(replacementIdentity);
    expect(receipt(f.env)?.receipt.sharedFile).toEqual(readClientCredentialFileIdentity(f.anchor));
    for (const [name, bytes] of Object.entries(retained)) {
      expect(fs.readFileSync(path.join(legacy, name), "utf8")).toBe(bytes);
    }
    const client = new Client({ connectionString: connection });
    await client.connect();
    try {
      const result = await client.query(
        `SELECT device_id, tokens_json FROM "${f.namespace}".device_pairing_paired`,
      );
      expect(result.rows).toEqual([
        {
          device_id: "retained-remote",
          tokens_json: '{"operator":{"token":"synthetic-remote-token"}}',
        },
      ]);
    } finally {
      await client.end();
    }
  }, 300_000);

  it("migrates authoritative PostgreSQL credentials without identity-change consent", async () => {
    const f = await bootstrap("postgres", true);
    fs.rmSync(path.dirname(f.local), { recursive: true });
    const migrated = await doctor(f, ["--fix", "--non-interactive"]);
    expect(migrated.code, migrated.stderr || migrated.stdout).toBe(0);
    expect(migrated.stdout + migrated.stderr).not.toContain("Create new local client identities?");
    expect(loadDeviceIdentityIfPresent({ env: f.env })?.deviceId).toBe(f.identity.deviceId);
    using owner = openClientCredentialCustody(f.env, { readOnly: true })!;
    expect(
      owner.database
        .prepare("SELECT token FROM device_auth_tokens WHERE device_id = ? AND role = 'operator'")
        .get(f.identity.deviceId)?.token,
    ).toBe("synthetic-before-cutover-token");
  }, 300_000);

  it("requires consent and gives the recovery command at Gateway startup", async () => {
    const f = await bootstrap();
    fs.rmSync(path.dirname(f.local), { recursive: true });
    for (const args of [["--non-interactive"], ["--fix", "--non-interactive"]]) {
      const refused = await doctor(f, args);
      expect(refused.code, refused.stderr).not.toBe(0);
      expect(refused.stdout + refused.stderr).toContain("openclaw doctor --fix --yes");
      expect(fs.existsSync(f.local)).toBe(false);
    }
    const startup = await runBuiltRuntime(
      runtimeRoot,
      f.env,
      ["gateway", "run", "--allow-unconfigured"],
      60_000,
    );
    expect(startup.code, startup.stderr).not.toBe(0);
    expect(startup.stdout + startup.stderr).toContain("openclaw doctor --fix");
    expect(fs.existsSync(f.local)).toBe(false);
  }, 300_000);

  it.each(["missing receipt", "mismatched", "corrupt"] as const)(
    "preserves the existing %s store and refusal even with --fix --yes",
    async (kind) => {
      const f = await bootstrap();
      if (kind === "corrupt") {
        fs.writeFileSync(f.local, "corrupt credential store");
      } else {
        using owner = openClientCredentialCustody(f.env, { migration: true })!;
        if (kind === "missing receipt") {
          owner.transaction(() => owner.database.exec("DELETE FROM client_credential_migration"));
        } else {
          const stored = readClientCredentialReceipt(owner.database)!;
          stored.receipt.source!.identity = "another-store";
          owner.transaction(() =>
            writeClientCredentialReceipt(owner.database, stored.receipt, "complete"),
          );
        }
      }
      replaceAnchor(f.anchor);
      const before = fs.readFileSync(f.local);
      const ordinary = await runBuiltRuntime(
        runtimeRoot,
        f.env,
        ["doctor", "--client-credentials", "--repair", "--non-interactive", "--json"],
        60_000,
      );
      const explicit = await doctor(f);
      expect(ordinary.code, ordinary.stderr).toBe(2);
      expect(explicit.code, explicit.stderr).not.toBe(0);
      const message = JSON.parse(ordinary.stdout).error.message;
      expect(explicit.stdout + explicit.stderr).toContain(message);
      if (kind === "missing receipt") {
        expect(message).toBe("Local credential receipt is missing; restore its matching backup.");
      }
      if (kind === "mismatched") {
        expect(message).toBe(
          "Local credentials do not match the shared database; restore their matched backup.",
        );
      }
      expect(fs.readFileSync(f.local)).toEqual(before);
    },
    300_000,
  );

  it("leaves a healthy present store and missing SQLite credentials unchanged", async () => {
    const healthy = await bootstrap();
    const bytes = fs.readFileSync(healthy.local);
    const unchanged = await doctor(healthy);
    expect(unchanged.code, unchanged.stderr).toBe(0);
    expect(fs.readFileSync(healthy.local)).toEqual(bytes);
    expect(loadDeviceIdentityIfPresent({ env: healthy.env })).toEqual(healthy.identity);
    const sqlite = await bootstrap("sqlite");
    fs.rmSync(path.dirname(sqlite.local), { recursive: true });
    const ordinary = await runBuiltRuntime(
      runtimeRoot,
      sqlite.env,
      ["doctor", "--client-credentials", "--repair", "--non-interactive", "--json"],
      60_000,
    );
    const explicit = await doctor(sqlite);
    expect(ordinary.code, ordinary.stderr).toBe(2);
    expect(JSON.parse(ordinary.stdout).error.message).toBe(
      "Client credential migration is incomplete or stale; run openclaw doctor --fix before using this client.",
    );
    expect(explicit.code, explicit.stderr).not.toBe(0);
    expect((explicit.stdout + explicit.stderr).replace(/[│\s]+/g, " ")).toContain(missingMessage);
    expect(fs.existsSync(sqlite.local)).toBe(false);
  }, 300_000);
});
