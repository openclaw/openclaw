import "../../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { parseUpdateRecoveryBackupManifest } from "../../commands/backup-verify-manifest.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { fingerprintPostgresDatabase } from "../../snapshot/database-backup-core.worker.js";
import { readBackupEngine } from "../../snapshot/database-backup.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  resolveClientCredentialStorePath,
  runClientCredentialOperation,
} from "../client-credential-store.js";
import { acquireGatewayLock } from "../gateway-lock.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { runLegacyStateMigrationSteps } from "../state-migrations.steps.js";
import { UpdateCandidatePluginPlanSchema } from "../update-candidate-plugins.js";
import {
  parseUpdateStateInspectionWorker,
  runUpdateStateInspectionWorker,
} from "../update-candidate-state.inspection.js";
import {
  UpdateCandidateSnapshotInventorySchema,
  UpdateCandidateStateSnapshotSchema,
  UpdateStateSchemaInspectionPlanSchema,
} from "../update-candidate-state.js";
import {
  createUpdateDatabaseBackup,
  type UpdateDatabaseBackup,
} from "../update-database-backup.js";
import { assertUpdateDatabaseEngineContexts } from "../update-database-engine-admission.js";
import { restoreUpdateDatabaseBackup } from "../update-database-restore.js";
import { captureUpdateRecoveryBaseline } from "../update-recovery-baseline-capture.js";
import { agentPortProvider } from "./agent-port.js";
import { resolveDatabaseEngineSelection } from "./config.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { materializeDatabasePort } from "./port.worker.js";
import { statePortProvider } from "./state-port.js";
import {
  activateUpdatePostgresPluginFixtures,
  createTeamReportsPortFixture,
  updatePostgresFamilies as families,
} from "./update-preflight.conformance.test-support.js";
const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
// The suite owns shared inputs so a failed case drain prevents their later removal.
const suiteLifetime = createFixtureLifetime();
const caseLifetime = createFixtureLifetime();
afterAll(() => suiteLifetime.cleanup());
const runId = "postgres-update-conformance";
function createAnchor(pathname: string, storeId: string, namespace: string) {
  using anchor = openNodeSqliteDatabase(pathname);
  anchor.exec(
    "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
  );
  anchor
    .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
    .run(storeId, namespace);
}

describe.skipIf(!connection)("PostgreSQL updater preflight and exact recovery", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  const additionalAnchors: string[] = [];
  let root: string;
  let stateDir: string;
  let shared: string;
  let agent: string;
  let plugin: string;
  let namespace: string;
  let config: OpenClawConfig;
  let env: NodeJS.ProcessEnv;
  let anchorCreated = false;
  beforeAll(() =>
    caseLifetime.run(async () => {
      await client.connect();
      root = await fs.realpath(suiteLifetime.createTempDir("update-postgres-"));
      stateDir = path.join(root, "state");
      shared = path.join(stateDir, "state", "openclaw.sqlite");
      agent = path.join(root, "registered-agent", "openclaw-agent.sqlite");
      plugin = path.join(stateDir, "npm", "projects", "fixture", "node_modules", "fixture-plugin");
      const configPath = path.join(stateDir, "openclaw.json");
      env = {
        ...process.env,
        HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      };
      config = { database: { engine: "postgres", postgres: { connection: connection! } } };
      for (const directory of [path.dirname(shared), path.dirname(agent), plugin]) {
        await fs.mkdir(directory, { recursive: true });
      }
      await fs.writeFile(configPath, JSON.stringify(config));
      await fs.writeFile(
        path.join(plugin, "package.json"),
        '{"name":"fixture-plugin","version":"1.0.0"}',
      );
      await fs.writeFile(path.join(plugin, "index.js"), "export default {};\n");
      {
        using db = openNodeSqliteDatabase(agent);
        db.exec(
          "PRAGMA user_version = 7; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('agent baseline')",
        );
      }
      const descriptor = await statePortProvider.loadDescriptor();
      const storeId = randomUUID();
      namespace = `update_conformance_${storeId.replaceAll("-", "")}`;
      namespaces.add(namespace);
      {
        using source = openNodeSqliteDatabase(":memory:");
        source.exec(descriptor.sqlite);
        for (const fragment of descriptor.fragments ?? []) {
          source.exec(fragment.sqlite);
        }
        source.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
        source
          .prepare("INSERT INTO schema_meta VALUES ('primary', 'global', ?, NULL, NULL, 1, 1)")
          .run(OPENCLAW_STATE_SCHEMA_VERSION);
        for (const [key, value] of [
          ["state.schema.contentVersion", String(OPENCLAW_STATE_SCHEMA_VERSION)],
          ["update.conformance", ' {"value":"baseline","opaque":"\\u0061"} '],
          [
            "plugins.installedIndex",
            JSON.stringify({
              revision: 1,
              index: {
                installRecords: {
                  fixture: { source: "npm", spec: "fixture-plugin@1.0.0", installPath: plugin },
                },
              },
            }),
          ],
        ] as const) {
          source.prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)").run(key, value);
        }
        source
          .prepare(
            "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES ('registered', ?, 7, 1)",
          )
          .run(agent);
        source
          .prepare(
            "INSERT INTO update_runs (run_id, created_at_ms, updated_at_ms, trigger, phase, status, origin_json, target_json, before_json, after_json, steps_json, verification_json, repair_json) VALUES (?, 1, 1, 'cli', 'requested', 'running', '{}', '{}', '{}', '{}', '[]', '{}', '[]')",
          )
          .run(runId);
        await materializeDatabasePort({
          source: { engine: "sqlite", db: source },
          destination: { engine: "postgres", db: client, namespace },
          descriptor,
          storeId,
          assertCurrent() {},
        });
      }
      createAnchor(shared, storeId, namespace);
      anchorCreated = true;
      for (const key of [
        "HOME",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
      ]) {
        vi.stubEnv(key, env[key]);
      }
      resetDatabaseEngineSelectionForTest();
      installDatabaseEngineSelection(await resolveDatabaseEngineSelection(config, env));
    }),
  );

  // A timeout rejects Vitest's wrapper before the original body releases its owner.
  afterEach(() => suiteLifetime.verifyCleanup(() => caseLifetime.cleanup()));

  afterAll(async () => {
    await suiteLifetime.verifyCleanup(() => caseLifetime.cleanup());
    return suiteLifetime.verifyCleanup(async () => {
      await closeOpenClawStateDatabaseAsync();
      resetDatabaseEngineSelectionForTest();
      vi.unstubAllEnvs();
      try {
        if (anchorCreated) {
          for (const pathname of [shared, ...additionalAnchors]) {
            const restored = readBackupEngine(pathname);
            if (restored.engine === "postgres") {
              namespaces.add(restored.namespace);
            }
          }
        }
        for (const name of namespaces) {
          await client.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
        }
      } finally {
        await client.end();
      }
    });
  });
  async function inspect(mode: string, extra: Record<string, unknown> = {}) {
    const stagingRoot = path.join(root, `inspection-${randomUUID()}`);
    await fs.mkdir(stagingRoot);
    return runUpdateStateInspectionWorker({
      nodeRunner: process.execPath,
      sourceEnv: env,
      stagingRoot,
      databases: [{ path: shared, sizeBytes: (await fs.stat(shared, { bigint: true })).size }],
      input: { stateDir, config, mode, stagingRoot, ...extra },
    });
  }

  it("reads PostgreSQL inventory and a retained legacy SQLite agent without changing the anchor", () =>
    caseLifetime.run(async () => {
      const before = await fs.readFile(shared);
      const targetStateDir = path.join(root, "inventory");
      const candidateRoot = path.join(root, "candidate");
      await fs.mkdir(candidateRoot);
      await fs.writeFile(path.join(candidateRoot, "package.json"), '{"name":"openclaw"}');
      const inventory = parseUpdateStateInspectionWorker(
        await inspect("inventory", { targetStateDir, candidateRoot }),
        UpdateCandidateSnapshotInventorySchema,
      );
      expect([...inventory.databases.values()].flatMap((entry) => entry.spellings)).toContain(
        agent,
      );
      const plan = UpdateCandidatePluginPlanSchema.parse(
        JSON.parse(await fs.readFile(path.join(targetStateDir, inventory.pluginPlan), "utf8")),
      );
      expect(plan.bindings).toContainEqual(expect.objectContaining({ source: plugin }));
      const discovery = parseUpdateStateInspectionWorker(
        await inspect("discover"),
        UpdateStateSchemaInspectionPlanSchema,
      );
      expect(discovery.sharedVersion).toMatchObject({
        path: shared,
        userVersion: OPENCLAW_STATE_SCHEMA_VERSION,
        contentVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      const versions = parseUpdateStateInspectionWorker(
        await inspect("versions", { inspectionPlan: discovery }),
        z.array(z.object({ path: z.string(), userVersion: z.number().nullable() }).passthrough()),
      );
      expect(versions).toContainEqual(expect.objectContaining({ path: agent, userVersion: 7 }));
      parseUpdateStateInspectionWorker(
        await inspect("snapshot", {
          targetStateDir,
          candidateRoot,
          pluginPlanPath: path.join(targetStateDir, inventory.pluginPlan),
          databaseInventory: [...inventory.databases.keys()],
        }),
        UpdateCandidateStateSnapshotSchema,
      );
      const privateShared = path.join(targetStateDir, "state", "openclaw.sqlite");
      {
        using copied = openNodeSqliteDatabase(privateShared, { readOnly: true });
        expect(
          copied
            .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
            .get("update.conformance"),
        ).toEqual({ value_json: ' {"value":"baseline","opaque":"\\u0061"} ' });
        const row = copied
          .prepare("SELECT path FROM agent_databases WHERE agent_id = ?")
          .get("registered");
        expect(row?.path).toEqual(expect.stringMatching(/^candidate-external\//));
        using copiedAgent = openNodeSqliteDatabase(
          path.resolve(targetStateDir, String(row?.path)),
          {
            readOnly: true,
          },
        );
        expect(copiedAgent.prepare("SELECT value FROM evidence").get()).toEqual({
          value: "agent baseline",
        });
      }
      expect(
        (
          await client.query(
            `SELECT path FROM "${namespace}".agent_databases WHERE agent_id = 'registered'`,
          )
        ).rows,
      ).toEqual([{ path: agent }]);
      expect(await fs.readFile(shared)).toEqual(before);
    }));

  it("refuses an unsupported state family before disturbing the previous Gateway", () =>
    caseLifetime.run(async () => {
      const previous = await acquireGatewayLock({
        env,
        role: "gateway",
        allowInTests: true,
        timeoutMs: 0,
      });
      const before = await fs.readFile(shared);
      try {
        await expect(
          assertUpdateDatabaseEngineContexts(
            [{ config, env }],
            ["sqlite", "postgres"],
            ["workboard", "logbook", "team-reports"],
          ),
        ).rejects.toThrow(/state.*(port|version|candidate)|(?:port|version|candidate).*state/i);
        previous!.assertCurrent();
        expect(await fs.readFile(shared)).toEqual(before);
      } finally {
        await previous!.release();
      }
    }));
  describe("five-family recovery below candidate admission", () => {
    const stores: Array<(typeof families)[number] & { pathname: string; namespace: string }> = [];
    const agentJson = ' {"value":"agent baseline","opaque":"\\u0061"} ';
    const agentBlob = Buffer.from([0, 255, 128, 1]);
    let agentNamespace: string;
    let agentStoreId: string;
    beforeAll(() =>
      caseLifetime.run(async () => {
        await client.query(
          `DELETE FROM "${namespace}".agent_databases WHERE agent_id = 'registered'`,
        );
        await fs.unlink(agent);
        const agentDescriptor = await agentPortProvider.loadDescriptor();
        agentStoreId = randomUUID();
        agentNamespace = `update_agent_${agentStoreId.replaceAll("-", "")}`;
        namespaces.add(agentNamespace);
        {
          using source = openNodeSqliteDatabase(":memory:");
          source.exec(agentDescriptor.sqlite);
          source.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
          source
            .prepare(
              "INSERT INTO schema_meta VALUES ('primary', 'agent', ?, 'registered', NULL, 1, 1)",
            )
            .run(OPENCLAW_AGENT_SCHEMA_VERSION);
          source
            .prepare(
              "INSERT INTO cache_entries (scope, key, value_json, blob, updated_at) VALUES ('update-conformance', 'retained', ?, ?, 1)",
            )
            .run(agentJson, agentBlob);
          await materializeDatabasePort({
            source: { engine: "sqlite", db: source },
            destination: { engine: "postgres", db: client, namespace: agentNamespace },
            descriptor: agentDescriptor,
            storeId: agentStoreId,
            assertCurrent() {},
          });
        }
        createAnchor(agent, agentStoreId, agentNamespace);
        additionalAnchors.push(agent);
        await client.query(
          `INSERT INTO "${namespace}".agent_databases (agent_id, path, schema_version, last_seen_at) VALUES ('registered', $1, $2, 1)`,
          [agent, OPENCLAW_AGENT_SCHEMA_VERSION],
        );
        const pluginRoots: string[] = [];
        // Descriptor loading precedes publishing the complete plugin fixture config.
        vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");
        vi.stubEnv(
          "OPENCLAW_BUNDLED_PLUGINS_DIR",
          fileURLToPath(new URL("../../../extensions", import.meta.url)),
        );
        for (const family of families) {
          const id = family.provider.id;
          const sourceRoot = fileURLToPath(new URL(`../../../extensions/${id}`, import.meta.url));
          const rootDir =
            id === "team-reports"
              ? await createTeamReportsPortFixture(path.join(root, "plugins", id), sourceRoot)
              : sourceRoot;
          pluginRoots.push(rootDir);
          const descriptor = await family.provider.loadDescriptor({
            id,
            rootDir,
            source: path.join(rootDir, id === "team-reports" ? "index.js" : "index.ts"),
            origin: "global",
          });
          const pathname = path.join(stateDir, family.relativePath);
          const storeId = randomUUID();
          const storeNamespace = `update_${id.replaceAll("-", "_")}_${storeId.replaceAll("-", "")}`;
          namespaces.add(storeNamespace);
          await fs.mkdir(path.dirname(pathname), { recursive: true });
          {
            using source = openNodeSqliteDatabase(":memory:");
            source.exec(descriptor.sqlite);
            source.exec(family.seed);
            await materializeDatabasePort({
              source: { engine: "sqlite", db: source },
              destination: { engine: "postgres", db: client, namespace: storeNamespace },
              descriptor,
              storeId,
              assertCurrent() {},
            });
            if (id === "logbook") {
              const input = {
                client,
                descriptor,
                anchor: { engine: "postgres" as const, storeId, namespace: storeNamespace },
              };
              const fingerprint = await fingerprintPostgresDatabase(input);
              await client.query("SET enable_hashjoin = off; SET enable_mergejoin = off");
              try {
                expect(await fingerprintPostgresDatabase(input)).toBe(fingerprint);
              } finally {
                await client.query("RESET enable_hashjoin; RESET enable_mergejoin");
              }
            }
          }
          createAnchor(pathname, storeId, storeNamespace);
          additionalAnchors.push(pathname);
          stores.push({ ...family, pathname, namespace: storeNamespace });
        }
        config = {
          ...config,
          plugins: {
            load: { paths: pluginRoots },
            entries: Object.fromEntries(
              families.map(({ provider }) => [provider.id, { enabled: true }]),
            ),
          },
        };
        await activateUpdatePostgresPluginFixtures(config, env, path.dirname(pluginRoots[0]!));
      }),
    );

    it("admits homogeneous PostgreSQL with a retained agent without disturbing the previous Gateway", () =>
      caseLifetime.run(async () => {
        const previous = await acquireGatewayLock({
          env,
          role: "gateway",
          allowInTests: true,
          timeoutMs: 0,
        });
        const before = await Promise.all([fs.readFile(shared), fs.readFile(agent)]);
        try {
          await expect(
            assertUpdateDatabaseEngineContexts(
              [{ config, env }],
              ["sqlite", "postgres"],
              ["state", "agent", "workboard", "logbook", "team-reports"],
            ),
          ).resolves.toBeUndefined();
          previous!.assertCurrent();
          expect(await Promise.all([fs.readFile(shared), fs.readFile(agent)])).toEqual(before);
        } finally {
          await previous!.release();
        }
      }));

    it("seals an original recovery baseline containing all PostgreSQL families", () =>
      caseLifetime.run(async () => {
        const owner = await acquireGatewayLock({
          env,
          role: "sqlite-maintenance",
          allowInTests: true,
          timeoutMs: 0,
        });
        try {
          const baseline = await owner!.run(() =>
            captureUpdateRecoveryBaseline({
              runId: "postgres-original-baseline",
              installRoot: root,
              env,
              drivers: [],
              assertCurrent: () => owner!.assertCurrent(),
              acquisition: { mode: "maintenance-owner" },
            }),
          );
          expect(baseline.diagnostics.databaseWarnings).toEqual([]);
          const manifest = parseUpdateRecoveryBackupManifest(
            await fs.readFile(baseline.ref.manifestPath, "utf8"),
          );
          expect(manifest).toMatchObject({ schemaVersion: 2, generation: { kind: "baseline" } });
        } finally {
          await owner!.release();
        }
      }));
    it("captures a retained PostgreSQL agent and restores local credentials after candidate failure while preserving current update history", () =>
      caseLifetime.run(async () => {
        const identity = {
          identity_key: "node",
          device_id: "synthetic-local-device",
          public_key_pem: "synthetic-public-key",
          private_key_pem: "synthetic-private-key",
          created_at_ms: 11,
          updated_at_ms: 12,
        };
        const key = {
          device_id: identity.device_id,
          role: "v2.synthetic.operator",
          gateway_scope: "synthetic-gateway",
        };
        const token = {
          device_id: key.device_id,
          role: key.role,
          token: "synthetic-original-client-token",
          scopes_json: '["operator.read"]',
          updated_at_ms: 13,
        };
        const socket = {
          socket_key: "current" as const,
          socket_path: path.join(root, "synthetic.sock"),
          socket_token: "synthetic-original-socket-token",
          updated_at_ms: 14,
        };
        runClientCredentialOperation(env, { kind: "identity.create", identity });
        runClientCredentialOperation(env, {
          kind: "token.replace",
          key,
          token,
          expectedToken: null,
        });
        runClientCredentialOperation(env, { kind: "socket.create", socket });
        const owner = await acquireGatewayLock({
          env,
          role: "sqlite-maintenance",
          allowInTests: true,
          timeoutMs: 0,
        });
        let backup: UpdateDatabaseBackup | undefined;
        try {
          backup = await owner!.run(() =>
            createUpdateDatabaseBackup({
              backupRoot: path.join(root, "rollback"),
              stateDir,
              config,
              env,
              acquisition: { mode: "maintenance-owner" },
            }),
          );
          expect(backup.warnings).toEqual([]);
          const capturedAgent = backup.databases.find((entry) => entry.path === agent);
          expect(capturedAgent).toMatchObject({
            engine: "postgres",
            storeId: agentStoreId,
            namespace: agentNamespace,
          });
          if (!capturedAgent?.exportDirectory) {
            throw new Error("Retained agent has no matched PostgreSQL capture");
          }
          {
            using image = openNodeSqliteDatabase(
              path.join(capturedAgent.exportDirectory, "database.sqlite"),
              { readOnly: true },
            );
            expect(
              image
                .prepare(
                  "SELECT value_json, blob FROM cache_entries WHERE scope = 'update-conformance' AND key = 'retained'",
                )
                .get(),
            ).toEqual({
              value_json: agentJson,
              blob: new Uint8Array(agentBlob),
            });
          }
          const local = backup.databases.find(
            (entry) => entry.path === resolveClientCredentialStorePath(env),
          );
          expect(local).toMatchObject({ userVersion: 1 });
          expect(local?.engine).toBeUndefined();
          {
            using captured = openNodeSqliteDatabase(local!.snapshotPath, { readOnly: true });
            expect(
              captured.prepare("SELECT socket_token FROM native_exec_socket_credentials").get(),
            ).toEqual({ socket_token: socket.socket_token });
          }
          const migration = await owner!.run(() =>
            runLegacyStateMigrationSteps([
              {
                id: "update-conformance-failure",
                phase: "shared",
                source: [],
                target: [],
                requiredness: "required",
                reversibility: "not-applicable",
                run: async () => {
                  await client.query(
                    `UPDATE "${namespace}".config_machine_state SET value_json = '"candidate"' WHERE state_key = 'update.conformance'`,
                  );
                  await client.query(
                    `UPDATE "${namespace}".update_runs SET phase = 'validating', updated_at_ms = 2, reason = 'candidate migration failed', after_json = $1 WHERE run_id = $2`,
                    [' {"opaque":"\\u0062"} ', runId],
                  );
                  for (const store of stores) {
                    await client.query(
                      `UPDATE "${store.namespace}"."${store.table}" SET "${store.column}" = 'candidate'`,
                    );
                  }
                  await client.query(
                    `UPDATE "${agentNamespace}".cache_entries SET value_json = '"candidate"', blob = $1 WHERE scope = 'update-conformance' AND key = 'retained'`,
                    [Buffer.from([9, 8, 7])],
                  );
                  runClientCredentialOperation(env, {
                    kind: "token.replace",
                    key,
                    token: {
                      ...token,
                      token: "synthetic-candidate-client-token",
                      updated_at_ms: 21,
                    },
                    expectedToken: token.token,
                  });
                  runClientCredentialOperation(env, {
                    kind: "socket.replace",
                    socket: {
                      ...socket,
                      socket_token: "synthetic-candidate-socket-token",
                      updated_at_ms: 22,
                    },
                    expectedToken: socket.socket_token,
                  });
                  throw new Error("candidate migration failed after committed data write");
                },
              },
            ]),
          );
          expect(migration.haltedBy?.refusal?.code).toBe("step-threw");
          expect(
            (
              await client.query(
                `SELECT value_json FROM "${namespace}".config_machine_state WHERE state_key = 'update.conformance'`,
              )
            ).rows,
          ).toEqual([{ value_json: '"candidate"' }]);
          expect(runClientCredentialOperation(env, { kind: "token.read", key })).toMatchObject({
            token: { token: "synthetic-candidate-client-token" },
          });
        } finally {
          await owner!.release();
        }
        await restoreUpdateDatabaseBackup({
          backup: backup!,
          runId,
          env,
          assertCurrent() {},
        });
        const restored = readBackupEngine(shared);
        if (restored.engine !== "postgres") {
          throw new Error("Recovery replaced the PostgreSQL anchor with SQLite data");
        }
        namespaces.add(restored.namespace);
        expect(
          runClientCredentialOperation(env, { kind: "identity.read", identity_key: "node" }),
        ).toEqual({ kind: "identity", identity });
        expect(runClientCredentialOperation(env, { kind: "token.read", key })).toEqual({
          kind: "token",
          token,
        });
        expect(runClientCredentialOperation(env, { kind: "socket.read" })).toEqual({
          kind: "socket",
          socket,
        });
        expect(
          (
            await client.query(
              `SELECT value_json FROM "${restored.namespace}".config_machine_state WHERE state_key = 'update.conformance'`,
            )
          ).rows,
        ).toEqual([{ value_json: ' {"value":"baseline","opaque":"\\u0061"} ' }]);
        expect(
          (
            await client.query(
              `SELECT phase, reason, after_json FROM "${restored.namespace}".update_runs WHERE run_id = $1`,
              [runId],
            )
          ).rows,
        ).toEqual([
          {
            phase: "validating",
            reason: "candidate migration failed",
            after_json: ' {"opaque":"\\u0062"} ',
          },
        ]);
        const restoredAgent = readBackupEngine(agent);
        if (restoredAgent.engine !== "postgres") {
          throw new Error("Recovery replaced the retained PostgreSQL agent with SQLite data");
        }
        namespaces.add(restoredAgent.namespace);
        expect(
          (
            await client.query(
              `SELECT value_json, blob FROM "${restoredAgent.namespace}".cache_entries WHERE scope = 'update-conformance' AND key = 'retained'`,
            )
          ).rows,
        ).toEqual([{ value_json: agentJson, blob: agentBlob }]);
        expect(
          (
            await client.query(
              `SELECT path FROM "${restored.namespace}".agent_databases WHERE agent_id = 'registered'`,
            )
          ).rows,
        ).toEqual([{ path: agent }]);
        for (const store of stores) {
          const restoredStore = readBackupEngine(store.pathname);
          if (restoredStore.engine !== "postgres") {
            throw new Error(`Recovery replaced ${store.provider.id} with SQLite data`);
          }
          namespaces.add(restoredStore.namespace);
          expect(
            (
              await client.query(
                `SELECT "${store.column}" AS value FROM "${restoredStore.namespace}"."${store.table}"`,
              )
            ).rows,
          ).toEqual([{ value: "baseline" }]);
        }
      }));
  });
});
