import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import "./database-suite-workers.test-support.js";
import * as terminal from "../../../packages/terminal-core/src/note.js";
import { createBackupResourcePlan } from "../../commands/backup-resource-inventory.js";
import { noteDatabaseEngines } from "../../commands/doctor-database-engine.js";
import { doctorDatabasePort } from "../../commands/doctor-database-port.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveActivatedPluginBackupInventory } from "../../plugins/manifest-backup-resources.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import {
  preparePostgresRestore,
  readBackupEngine,
  verifyMatchedPostgresBackup,
} from "../../snapshot/database-backup.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { preparePostgresBackupDiscovery } from "../backup-database-discovery.js";
import { createBackupSqliteSnapshotPlan } from "../backup-sqlite-snapshot.js";
import * as recovery from "../database-port-recovery.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import * as snapshots from "../sqlite-snapshot.js";
import { runPluginDoctorStateMigrationPlans } from "../state-migrations.plugin-doctor.js";
import { resolveDatabaseEngineSelection } from "./config.js";
import { withDatabaseEngineSelection } from "./context.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const cryptoValue = JSON.stringify({
  version: 1,
  kind: "snapshot-chunk",
  data: Buffer.from("synthetic Matrix crypto session: 🦞\0").toString("base64"),
});
const selectEntries =
  "SELECT namespace, entry_key, value_json FROM plugin_state_entries WHERE plugin_id = 'matrix' ORDER BY namespace, entry_key";
type MatrixPaths = {
  resolveMatrixAccountStorageRoot(params: {
    stateDir: string;
    homeserver: string;
    userId: string;
    accessToken: string;
    accountId: string;
  }): { rootDir: string };
};

describe.skipIf(!connection)("Matrix declared account-root database portability", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  let matrix: MatrixPaths;

  beforeAll(async () => {
    await client.connect();
    matrix = loadBundledPluginPublicArtifactModuleSync<MatrixPaths>({
      dirName: "matrix",
      artifactBasename: "runtime-api.js",
    });
  });

  afterAll(async () => {
    try {
      for (const namespace of namespaces) {
        assert.match(namespace, /^(?:port|restore)_[a-f0-9]+$/);
        await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      }
    } finally {
      await client.end();
    }
  });

  async function withRoots(
    run: (state: OpenClawTestState, files: string[], config: OpenClawConfig) => Promise<void>,
  ) {
    await withOpenClawTestState({ scenario: "minimal", prefix: "matrix-port-" }, async (state) => {
      const config: OpenClawConfig = {
        plugins: { entries: { matrix: { enabled: false } } },
        database: { engine: "sqlite", postgres: { connection: connection! } },
      };
      await state.writeConfig(config);
      const files = [
        ["active", "synthetic-current-token"],
        ["active", "synthetic-retained-token"],
        ["disabled", "synthetic-disabled-token"],
      ].map(([accountId, accessToken]) =>
        path.join(
          matrix.resolveMatrixAccountStorageRoot({
            stateDir: state.stateDir,
            homeserver: "https://matrix.example.org",
            userId: "@synthetic:example.org",
            accountId: accountId!,
            accessToken: accessToken!,
          }).rootDir,
          "state",
          "openclaw.sqlite",
        ),
      );
      try {
        for (const [index, file] of files.entries()) {
          const { db } = openOpenClawStateDatabase({ path: file });
          db.prepare(
            "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at) VALUES ('matrix', 'idb-snapshot', ?, ?, 1)",
          ).run(`chunk-${index}`, cryptoValue);
        }
        await closeOpenClawStateDatabaseAsync();
        // Current crypto roots without legacy dedupe rows do not require a migration receipt.
        await expect(
          doctorDatabasePort({ family: "state", to: "postgres", dryRun: true }),
        ).resolves.toMatchObject({ phase: "preflight" });
        const retainedEntries = files.map(sqliteEntries);
        // Fresh crypto roots are port-ready; only genuine legacy dedupe rows require repair.
        const legacy = {
          roomId: "!legacy:example.org",
          eventId: "$before-upgrade",
          ts: Date.now(),
        };
        const legacyKey = `active:${createHash("sha256")
          .update(`active\0${legacy.roomId}\0${legacy.eventId}`)
          .digest("hex")}`;
        {
          using db = openNodeSqliteDatabase(files[0]!);
          db.prepare(
            "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at) VALUES ('matrix', 'inbound-dedupe', ?, ?, ?)",
          ).run(legacyKey, JSON.stringify(legacy), legacy.ts);
        }
        await expect(
          doctorDatabasePort({ family: "state", to: "postgres", dryRun: true }),
        ).rejects.toThrow(
          "Run openclaw doctor --fix first, then retry port. If a named plugin is disabled, enable it for repair.",
        );
        // Complete Doctor's retained-root scan before porting, then keep testing a disabled plugin.
        const repairConfig: OpenClawConfig = {
          ...config,
          plugins: { entries: { matrix: { enabled: true } } },
        };
        await state.writeConfig(repairConfig);
        const repaired = await runPluginDoctorStateMigrationPlans({
          detected: {
            stateDir: state.stateDir,
            oauthDir: state.statePath("credentials"),
            doctorOnlyStateMigrations: true,
          },
          config: repairConfig,
          env: state.env,
        });
        expect(repaired.warnings).toEqual([]);
        expect(repaired.completedPluginIds).toContain("matrix");
        await closeOpenClawStateDatabaseAsync();
        expect(files.map(sqliteEntries)).toEqual(retainedEntries);
        await state.writeConfig(config);
        await run(state, files, config);
      } finally {
        vi.restoreAllMocks();
        await closeOpenClawStateDatabaseAsync();
        const directory = state.statePath("recovery", "database-port");
        async function collectManifests(root: string, includeOperations = true): Promise<void> {
          for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
            const file = path.join(root, entry.name);
            // Nested PostgreSQL exports have their own manifest contract.
            if (entry.isDirectory() && includeOperations) {
              await collectManifests(file, false);
            } else if (entry.name === "manifest.json") {
              const saved = JSON.parse(
                await fs.readFile(file, "utf8"),
              ) as recovery.DatabasePortManifest;
              for (const target of saved.targets) {
                for (const location of [target.original, target.intended]) {
                  if (location.engine === "postgres") {
                    namespaces.add(location.namespace);
                  }
                }
              }
            }
          }
        }
        await collectManifests(directory);
      }
    });
  }

  function sqliteEntries(file: string) {
    using db = openNodeSqliteDatabase(file, { readOnly: true });
    return db.prepare(selectEntries).all();
  }

  async function postgresEntries(file: string) {
    const anchor = readBackupEngine(file);
    assert(anchor.engine === "postgres");
    namespaces.add(anchor.namespace);
    const result = await client.query(
      selectEntries.replace("plugin_state_entries", `"${anchor.namespace}".plugin_state_entries`),
    );
    return { anchor, entries: result.rows };
  }

  async function postgresRoots(files: string[]) {
    const roots = [];
    for (const file of files) {
      roots.push(await postgresEntries(file));
    }
    return roots;
  }

  it("ports every retained token/account root with the state family and restores fresh namespaces", async () => {
    await withRoots(async (state, files, config) => {
      const expected = files.map(sqliteEntries);
      const forward = await doctorDatabasePort({ family: "state", to: "postgres" });
      expect(forward).toMatchObject({ engine: "postgres" });
      const physical = await postgresRoots(files);
      expect(physical.map((root) => root.entries)).toEqual(expected);
      expect(new Set(physical.map((root) => root.anchor.namespace)).size).toBe(files.length);
      expect(new Set(physical.map((root) => root.anchor.storeId)).size).toBe(files.length);
      const agentPath = state.path("registered-agent", "openclaw-agent.sqlite");
      withDatabaseEngineSelection({ effectiveEngines: resolveDatabaseFamilyEngines({}) }, () => {
        const agent = openOpenClawAgentDatabase({
          agentId: "retained",
          path: agentPath,
          env: { ...state.env, OPENCLAW_STATE_DIR: state.path("native-agent-owner") },
        });
        agent.db
          .prepare(
            "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES ('retained-session', 'retained-id', ?, 1)",
          )
          .run('{"fixture":"registered agent"}');
        closeOpenClawAgentDatabasesForTest();
      });
      await closeOpenClawStateDatabaseAsync();
      const globalAnchor = readBackupEngine(state.statePath("state", "openclaw.sqlite"));
      assert(globalAnchor.engine === "postgres");
      await client.query(
        `INSERT INTO "${globalAnchor.namespace}".agent_databases (agent_id, path, schema_version, last_seen_at) VALUES ('retained', $1, $2, 1)`,
        [agentPath, OPENCLAW_AGENT_SCHEMA_VERSION],
      );
      const postgresConfig = {
        ...config,
        database: { ...config.database, families: { state: { engine: "postgres" } } },
      } satisfies OpenClawConfig;
      const deferredRegistry = await preparePostgresBackupDiscovery({
        stateDir: state.stateDir,
        config: postgresConfig,
        env: state.env,
        agentRegistry: [],
      });
      expect(deferredRegistry.paths).not.toContain(agentPath);
      expect(files.every((file) => deferredRegistry.paths.includes(file))).toBe(true);
      const note = vi.spyOn(terminal, "note").mockImplementation(() => {});
      for (const database of [
        { ...config.database, engine: "postgres" as const },
        {
          ...config.database,
          families: { state: { engine: "postgres" as const } },
        },
      ]) {
        clearPluginMetadataLifecycleCaches();
        const doctorConfig = { ...config, database };
        const selection = await resolveDatabaseEngineSelection(doctorConfig, state.env);
        const findings = await withDatabaseEngineSelection(selection, () =>
          noteDatabaseEngines(doctorConfig, { env: state.env }),
        );
        expect(findings.filter((finding) => files.includes(finding.path ?? ""))).toEqual([]);
        const output = String(note.mock.lastCall?.[0]);
        for (const [index, file] of files.entries()) {
          expect(output).toContain(
            `Shared state root: ${file} (physical=postgres, namespace=${physical[index]!.anchor.namespace})`,
          );
        }
      }
      const inventory = resolveActivatedPluginBackupInventory({
        config: postgresConfig,
        env: state.env,
        stateDir: state.stateDir,
      });
      const resources = await createBackupResourcePlan({
        stateDir: state.stateDir,
        configPaths: [],
        oauthDirs: [],
        workspaceDirs: [],
        excludedWorkspaceDirs: [],
        agentRoots: [],
        pluginResources: inventory.resources,
        pluginRoots: inventory.pluginRoots,
      });
      const tempDir = state.path("backup");
      await fs.mkdir(tempDir);
      const backup = await createBackupSqliteSnapshotPlan({
        resources,
        tempDir,
        legacyAuditSnapshots: [],
      });
      const capturedAgent = backup.snapshots.find((entry) => entry.archiveSourcePath === agentPath);
      expect(capturedAgent).toBeDefined();
      {
        using database = openNodeSqliteDatabase(capturedAgent!.sourcePath, { readOnly: true });
        expect(database.prepare("SELECT entry_json FROM session_nodes").get()?.entry_json).toBe(
          '{"fixture":"registered agent"}',
        );
      }
      const capturedGlobal = backup.snapshots.find(
        (entry) =>
          entry.archiveSourcePath ===
          `${state.statePath("state", "openclaw.sqlite")}.postgres/database.sqlite`,
      );
      expect(capturedGlobal).toBeDefined();
      {
        using database = openNodeSqliteDatabase(capturedGlobal!.sourcePath, { readOnly: true });
        expect(database.prepare("SELECT agent_id, path FROM agent_databases").all()).toEqual([
          { agent_id: "retained", path: agentPath },
        ]);
      }
      for (const [index, file] of files.entries()) {
        const directory = state.path(`restored-${index}`, path.basename(`${file}.postgres`));
        await fs.mkdir(directory, { recursive: true });
        const capsule = backup.snapshots.filter((entry) =>
          entry.archiveSourcePath.startsWith(`${file}.postgres/`),
        );
        expect(capsule).toHaveLength(3);
        for (const entry of capsule) {
          await fs.copyFile(
            entry.sourcePath,
            path.join(directory, path.basename(entry.archiveSourcePath)),
          );
        }
        const manifest = await verifyMatchedPostgresBackup(directory, "user-backup");
        expect(manifest.source).toMatchObject({ owner: "state" });
        const restoredPath = state.path(`restored-${index}.sqlite`);
        const restored = await preparePostgresRestore({
          directory,
          anchorPath: restoredPath,
          config: postgresConfig,
          profile: "user-backup",
          assertCurrent() {},
        });
        namespaces.add(restored.namespace);
        expect(restored.namespace).not.toBe(physical[index]!.anchor.namespace);
        const restoredEntries = await postgresEntries(restoredPath);
        expect(restoredEntries.anchor.storeId).toBe(physical[index]!.anchor.storeId);
        expect(restoredEntries.entries).toEqual(expected[index]);
      }
      // The native agent above exists only to prove backup registry coverage.
      await client.query(
        `DELETE FROM "${globalAnchor.namespace}".agent_databases WHERE agent_id = 'retained'`,
      );
      await doctorDatabasePort({ family: "state", to: "sqlite" });
      expect(files.map(readBackupEngine)).toEqual(files.map(() => ({ engine: "sqlite" })));
      expect(files.map(sqliteEntries)).toEqual(expected);
      expect(readBackupEngine(agentPath)).toEqual({ engine: "sqlite" });
    });
  }, 300_000);

  it.each(["resume", "rollback"] as const)(
    "%s recovers a partially published multi-root port and blocks ordinary startup meanwhile",
    async (action) => {
      await withRoots(async (state, files) => {
        const expected = files.map(sqliteEntries);
        const prepare = snapshots.prepareVerifiedSqliteFile;
        let published = 0;
        vi.spyOn(snapshots, "prepareVerifiedSqliteFile").mockImplementation(async (...args) => {
          const image = await prepare(...args);
          return {
            ...image,
            publish: async () => {
              if (++published === 2) {
                throw new Error("synthetic interrupted multi-root publication");
              }
              return image.publish();
            },
          };
        });
        await expect(doctorDatabasePort({ to: "postgres" })).rejects.toThrow("Database port");
        expect(published).toBe(2);
        vi.restoreAllMocks();
        const manifestPath = recovery.databasePortManifestPath(state.stateDir);
        const saved = JSON.parse(
          await fs.readFile(manifestPath, "utf8"),
        ) as recovery.DatabasePortManifest;
        expect(saved.state).toBe("publishing");
        expect(saved.targets).toHaveLength(files.length + 1);
        expect(new Set(files.map((file) => readBackupEngine(file).engine))).toEqual(
          new Set(["sqlite", "postgres"]),
        );
        expect(() => recovery.assertDatabasePortStartupAllowed(state.stateDir)).toThrow("--resume");
        expect(
          recovery.assertDatabasePortRecoveryAllowed(state.stateDir, {
            manifestPath,
            operationId: saved.operationId,
            action,
          }),
        ).toEqual(saved);
        await doctorDatabasePort({ [action]: manifestPath });
        expect(() => recovery.assertDatabasePortStartupAllowed(state.stateDir)).not.toThrow();
        if (action === "resume") {
          expect((await postgresRoots(files)).map((root) => root.entries)).toEqual(expected);
          await doctorDatabasePort({ to: "sqlite" });
        }
        expect(files.map(sqliteEntries)).toEqual(expected);
      });
    },
    300_000,
  );
});
